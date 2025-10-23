import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ====== CONFIG ======
const API_KEY = process.env.API_KEY || "gttherefast"; // cámbiala si quieres
const ORIGIN_ALLOW = null;   // p.ej. "https://yefany.repuestosdiaz.store"; null = sin restricción
const DEBUG = process.env.DEBUG === "1";
// ====================

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

    // Evitar popups: navegar en la misma pestaña
    await page.addInitScript(() => {
      const _open = window.open;
      window.open = function (url) {
        try { if (url) location.href = url; } catch {}
        return null;
      };
    });

    // 1) Ir a la web oficial
    await page.goto(
      "https://www.calidda.com.pe/atencion-al-cliente/descarga-tu-recibo",
      { waitUntil: "domcontentloaded" }
    );

    // 2) Detección temprana de CAPTCHA
    const captchaSelectors = [
      'iframe[src*="recaptcha"]',
      '.g-recaptcha',
      'iframe[src*="hcaptcha"]',
      '.h-captcha',
      '[data-sitekey]',
      'text=/no soy un robot/i'
    ];
    const captchaCount = await page.locator(captchaSelectors.join(",")).count();
    if (captchaCount) {
      await browser.close();
      return res
        .status(409)
        .type("text/html")
        .send(`
          <meta charset="utf-8">
          <style>
            body{font-family:system-ui,Segoe UI,Roboto,Arial;padding:28px;color:#222}
            .box{max-width:720px;margin:auto;border:1px solid #e5e7eb;border-radius:12px;padding:20px}
            a.btn{display:inline-block;margin-top:8px;background:#1c7ed6;color:#fff;text-decoration:none;padding:12px 16px;border-radius:10px}
            code{background:#f3f4f6;padding:2px 6px;border-radius:6px}
          </style>
          <div class="box">
            <h2>Necesitas resolver un CAPTCHA en Cálidda</h2>
            <p>Por seguridad, Cálidda está pidiendo un CAPTCHA. No puedo automatizarlo.</p>
            <p>Haz clic para abrir la página oficial, completa el desafío y descarga tu recibo:</p>
            <p><a class="btn" target="_blank" href="https://www.calidda.com.pe/atencion-al-cliente/descarga-tu-recibo">Abrir página de Cálidda</a></p>
            <hr>
            <p><strong>Datos que ingresaste</strong></p>
            <ul>
              <li>N° cliente: <code>${numero_cliente}</code></li>
              <li>Tipo doc: <code>${tipo_doc}</code></li>
              <li>N° doc: <code>${numero_doc}</code></li>
              <li>Año/Mes: <code>${anio || "-"}/${mes || "-"}</code></li>
            </ul>
          </div>
        `);
    }

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
    async function removeTargets() {
      try {
        await page.evaluate(() => {
          document.querySelectorAll('a[target="_blank"]').forEach(a => a.removeAttribute('target'));
        });
      } catch {}
    }
    async function findPdfHref(scope) {
      const href = await scope.evaluate(() => {
        function abs(u) { try { return new URL(u, location.href).href; } catch { return null; } }
        const links = Array.from(document.querySelectorAll('a[href*=".pdf"]'));
        for (const a of links) {
          const h = a.getAttribute("href") || "";
          if (/\.pdf(\b|$)/i.test(h)) {
            const full = abs(h);
            if (full) return full;
          }
        }
        return null;
      });
      return href;
    }
    async function tryDownloadViaHref(absUrl) {
      try {
        const resp = await ctx.request.get(absUrl, { timeout: 120000 });
        const ct = resp.headers()["content-type"] || "";
        const buf = await resp.body();
        if (ct.includes("application/pdf") || (absUrl || "").toLowerCase().endsWith(".pdf")) {
          return { ok: true, name: (absUrl.split("/").pop() || "recibo.pdf"), buf };
        }
      } catch {}
      return { ok: false };
    }
    async function pollAndDownloadByHref(scope, ms = 45000) {
      const start = Date.now();
      while (Date.now() - start < ms) {
        await removeTargets();
        const href = await findPdfHref(scope);
        if (href) {
          const r = await tryDownloadViaHref(href);
          if (r.ok) return r;
        }
        await scope.waitForTimeout(1000);
        try { await scope.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); } catch {}
      }
      return { ok: false };
    }

    // 3) Completar formulario
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

    // 4) Preparar capturas paralelas
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

    let popupPage = null;
    page.on("popup", p => { popupPage = p; });

    // 5) Click en "Consultar/Buscar"
    await removeTargets();
    const consultSelectors = [
      'button:has-text("Consultar")','button:has-text("Buscar")',
      'a:has-text("Consultar")','a:has-text("Buscar")',
      'button[type="submit"]','input[type="submit"]'
    ];
    for (const sel of consultSelectors) {
      const loc = page.locator(sel);
      if (await loc.count()) { await loc.first().click({ force: true }); break; }
    }
    await page.waitForLoadState("networkidle").catch(()=>{});

    // 6) PRIORIDAD 1: href .pdf vía request
    let r = await pollAndDownloadByHref(page, 45000);
    if (r.ok) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${r.name || ("recibo_"+numero_cliente+".pdf")}"`);
      res.send(r.buf);
      await browser.close();
      return;
    }

    // 7) PRIORIDAD 2: si hubo popup, buscar ahí
    if (popupPage) {
      try {
        await popupPage.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(()=>{});
        const r2 = await pollAndDownloadByHref(popupPage, 25000);
        if (r2.ok) {
          res.setHeader("Content-Type", "application/pdf");
          res.setHeader("Content-Disposition", `attachment; filename="${r2.name || ("recibo_"+numero_cliente+".pdf")}"`);
          res.send(r2.buf);
          await browser.close();
          return;
        }
      } catch {}
    }

    // 8) PRIORIDAD 3: descarga nativa
    const download = await downloadPromise;
    if (download) {
      const name = download.suggestedFilename() || `recibo_${numero_cliente}.pdf`;
      const stream = await download.createReadStream();
      if (stream) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
        stream.pipe(res);
        await new Promise(r3 => stream.on("end", r3));
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

    // 9) PRIORIDAD 4: sniffer
    if (sniffedPdf) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${sniffedName}"`);
      res.send(sniffedPdf);
      await browser.close();
      return;
    }

    // Debug
    if (DEBUG) {
      const fs = await import("fs");
      const ts = Date.now();
      try { await page.screenshot({ path: `/tmp/fail_${ts}.png`, fullPage: true }); } catch {}
      try { fs.writeFileSync(`/tmp/fail_${ts}.html`, await page.content()); } catch {}
      if (popupPage) {
        try { await popupPage.screenshot({ path: `/tmp/fail_popup_${ts}.png`, fullPage: true }); } catch {}
        try { fs.writeFileSync(`/tmp/fail_popup_${ts}.html`, await popupPage.content()); } catch {}
      }
    }

    await browser.close();
    res.status(404).send("No se pudo capturar el PDF (sin enlace .pdf, sin download, sin respuesta PDF).");

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
