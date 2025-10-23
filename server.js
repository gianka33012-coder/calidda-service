import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// === CONFIG ===
const API_KEY = process.env.API_KEY || "gttherefast";
const ORIGIN_ALLOW = null; // p.ej. "https://yefany.repuestosdiaz.store" para restringir origen; null = desactivado
const DEBUG = process.env.DEBUG === "1"; // si 1, guarda screenshot y HTML de error en /tmp
// =============

app.get("/", (_req, res) => res.type("text/plain").send("OK /"));
app.get("/status", (_req, res) => res.json({ ok: true }));

app.get("/descargar", (_req, res) =>
  res.status(405).type("text/plain").send("Usa POST /descargar")
);

app.post("/descargar", async (req, res) => {
  const providedKey = (req.headers["x-api-key"] || req.body?.api_key || "").toString();
  if (providedKey !== API_KEY) return res.status(401).send("Unauthorized");

  if (ORIGIN_ALLOW) {
    const origin = (req.headers.origin || req.headers.referer || "").toString();
    if (!origin.startsWith(ORIGIN_ALLOW)) return res.status(403).send("Forbidden origin");
  }

  const { numero_cliente, tipo_doc = "DNI", numero_doc, anio, mes } = req.body || {};
  if (!numero_cliente || !numero_doc) {
    return res.status(400).send("Faltan datos: numero_cliente y numero_doc");
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process",
      ],
    });

    const ctx = await browser.newContext({ acceptDownloads: true });
    ctx.setDefaultTimeout(180000);
    ctx.setDefaultNavigationTimeout(180000);

    const page = await ctx.newPage();

    // 1) Ir a Cálidda
    await page.goto(
      "https://www.calidda.com.pe/atencion-al-cliente/descarga-tu-recibo",
      { waitUntil: "domcontentloaded" }
    );

    // Helpers
    async function setBySelectors(posibles, val) {
      for (const sel of posibles) {
        const loc = page.locator(sel);
        if (await loc.count()) {
          try { await loc.first().fill(String(val)); return true; } catch {}
        }
      }
      return false;
    }
    async function selectByTextOrValue(sel, wanted) {
      const loc = page.locator(sel);
      if (!(await loc.count())) return false;
      const opts = await loc.first().locator("option").all();
      const U = (s) => (s || "").toUpperCase();
      for (const o of opts) {
        const v = U(await o.getAttribute("value"));
        const t = U(await o.innerText());
        if (v === U(wanted) || t.includes(U(wanted))) {
          await loc.first().selectOption({ value: await o.getAttribute("value") });
          return true;
        }
      }
      return false;
    }
    async function findAndClickAny(scope, selectors) {
      const loc = scope.locator(selectors.join(", "));
      if (await loc.count()) { await loc.first().click({ force: true }); return true; }
      return false;
    }
    async function pollForDownloadButtons(scope, ms = 45000) {
      const start = Date.now();
      const sels = [
        'a[href$=".pdf"]',
        'a[href*=".pdf"]',
        'a:has-text("Descargar")',
        'a:has-text("PDF")',
        'a:has-text("Recibo")',
        'button:has-text("Descargar")',
        'button:has-text("PDF")',
        'button:has-text("Recibo")',
      ];
      while (Date.now() - start < ms) {
        const ok = await findAndClickAny(scope, sels);
        if (ok) return true;
        await scope.waitForTimeout(1000);
        // intenta revelar contenido
        try { await scope.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); } catch {}
      }
      return false;
    }

    // 2) Completar formulario
    await setBySelectors([
      'input[name="numeroCliente"]','input[name="numCliente"]','input[name="nroCliente"]',
      'input[name="numero_cliente"]','input[placeholder*="cliente" i]','input[placeholder*="suministro" i]'
    ], numero_cliente);

    await selectByTextOrValue('select[name="tipoDocumento"], select[name="tipo_doc"], select', tipo_doc);

    await setBySelectors([
      'input[name="numeroDocumento"]','input[name="nroDocumento"]','input[name="numero_doc"]',
      'input[name="documento"]','input[placeholder*="documento" i]'
    ], numero_doc);

    if (anio) await selectByTextOrValue('select[name="anio"], select[name="year"]', anio);
    if (mes)  await selectByTextOrValue('select[name="mes"], select[name="month"]', String(mes).padStart(2,"0"));

    // 3) Preparar capturas en paralelo
    const downloadPromise = page.waitForEvent("download", { timeout: 120000 }).catch(() => null);

    let sniffedPdf = null, sniffedName = "recibo.pdf";
    page.on("response", async (resp) => {
      try {
        const ct = resp.headers()["content-type"] || "";
        if (ct.includes("application/pdf") && !sniffedPdf) {
          const url = resp.url();
          const body = await resp.body();
          sniffedPdf = Buffer.from(body);
          const tail = url.split("/").pop() || "";
          if (tail.toLowerCase().endsWith(".pdf")) sniffedName = tail;
        }
      } catch {}
    });

    // 4) Click en "Consultar" o "Buscar"
    await findAndClickAny(page, [
      'button:has-text("Consultar")','button:has-text("Buscar")',
      'a:has-text("Consultar")','a:has-text("Buscar")',
      'button[type="submit"]','input[type="submit"]'
    ]);
    await page.waitForLoadState("networkidle").catch(()=>{});

    // 5) Si el sitio ya dispara la descarga, bien; si no, buscar botones/enlaces de descarga globalmente (polling)
    //    No dependemos de ver el número de cliente en la UI.
    const clicked = await pollForDownloadButtons(page, 45000);

    // 6) Resolver las tres vías de obtención de PDF
    const download = await downloadPromise;

    if (download) {
      const name = download.suggestedFilename() || `recibo_${numero_cliente}.pdf`;
      const stream = await download.createReadStream();
      if (stream) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
        stream.pipe(res);
        await new Promise(r => stream.on("end", r));
        await browser.close();
        return;
      }
      const tmpPath = `/tmp/${Date.now()}_${name}`;
      await download.saveAs(tmpPath);
      const fs = await import("fs");
      const buf = fs.readFileSync(tmpPath);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
      res.send(buf);
      await browser.close();
      return;
    }

    if (sniffedPdf) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${sniffedName}"`);
      res.send(sniffedPdf);
      await browser.close();
      return;
    }

    // 7) Modo debug: dump de página si no se encontró nada
    if (DEBUG) {
      const fs = await import("fs");
      const ts = Date.now();
      try { await page.screenshot({ path: `/tmp/fail_${ts}.png`, fullPage: true }); } catch {}
      try { const html = await page.content(); fs.writeFileSync(`/tmp/fail_${ts}.html`, html); } catch {}
    }

    await browser.close();
    res.status(404).send(
      clicked
        ? "Se hizo clic en un botón de descarga pero no se pudo capturar el PDF (descarga en nueva pestaña o bloqueada)."
        : "No se encontró ningún botón/enlace de descarga tras consultar."
    );

  } catch (e) {
    if (DEBUG) {
      try {
        const fs = await import("fs");
        fs.writeFileSync(`/tmp/error_${Date.now()}.txt`, String(e?.stack || e));
      } catch {}
    }
    try { await browser?.close(); } catch {}
    res.status(500).send("Error: " + (e?.message || e));
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Calidda service listening on", port));
