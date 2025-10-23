import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const API_KEY = process.env.API_KEY || "gttherefast";

app.get("/", (_req, res) => res.type("text/plain").send("OK /"));
app.get("/status", (_req, res) => res.json({ ok: true }));
app.get("/descargar", (_req, res) =>
  res.status(405).type("text/plain").send("Usa POST /descargar")
);

app.post("/descargar", async (req, res) => {
  try {
    // Seguridad
    if ((req.headers["x-api-key"] || "") !== API_KEY) {
      return res.status(401).send("Unauthorized");
    }

    const { numero_cliente, tipo_doc = "DNI", numero_doc, anio, mes } = req.body || {};
    if (!numero_cliente || !numero_doc) {
      return res.status(400).send("Faltan datos: numero_cliente y numero_doc");
    }

    const browser = await chromium.launch({
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
    const page = await ctx.newPage();

    // --- Sniffer de PDFs por si el sitio responde con PDF vía XHR/fetch ---
    let sniffedPdf = null;
    let sniffedName = "recibo.pdf";
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

    // Ir a la página
    await page.goto(
      "https://www.calidda.com.pe/atencion-al-cliente/descarga-tu-recibo",
      { waitUntil: "domcontentloaded" }
    );

    // Helpers cortitos
    async function setBySelectors(pos, val) {
      for (const sel of pos) {
        const loc = page.locator(sel);
        if (await loc.count()) {
          try {
            await loc.first().fill(String(val));
            return true;
          } catch {}
        }
      }
      return false;
    }
    async function selectByTextOrValue(sel, wanted) {
      const loc = page.locator(sel);
      if (!(await loc.count())) return false;
      const opts = await loc.first().locator("option").all();
      const up = (s) => (s || "").toUpperCase();
      for (const o of opts) {
        const v = up(await o.getAttribute("value"));
        const t = up(await o.innerText());
        if (v === up(wanted) || t.includes(up(wanted))) {
          await loc.first().selectOption({ value: await o.getAttribute("value") });
          return true;
        }
      }
      return false;
    }

    // Completar formulario con múltiples variantes de nombres
    await setBySelectors(
      [
        'input[name="numeroCliente"]',
        'input[name="numCliente"]',
        'input[name="nroCliente"]',
        'input[name="numero_cliente"]',
        'input[placeholder*="cliente" i]',
        'input[placeholder*="suministro" i]',
      ],
      numero_cliente
    );

    await selectByTextOrValue(
      'select[name="tipoDocumento"], select[name="tipo_doc"], select',
      tipo_doc
    );

    await setBySelectors(
      [
        'input[name="numeroDocumento"]',
        'input[name="nroDocumento"]',
        'input[name="numero_doc"]',
        'input[name="documento"]',
        'input[placeholder*="documento" i]',
      ],
      numero_doc
    );

    if (anio) await selectByTextOrValue('select[name="anio"], select[name="year"]', anio);
    if (mes)
      await selectByTextOrValue(
        'select[name="mes"], select[name="month"]',
        String(mes).padStart(2, "0")
      );

    // Botón de consulta
    const btnConsultar = page.locator(
      [
        'button:has-text("Consultar")',
        'button:has-text("Buscar")',
        'a:has-text("Consultar")',
        'a:has-text("Buscar")',
        'button[type="submit"]',
        'input[type="submit"]',
      ].join(", ")
    );
    if (await btnConsultar.count()) {
      await Promise.all([page.waitForLoadState("networkidle"), btnConsultar.first().click()]);
    }

    // Esperar a que aparezcan resultados que contengan acciones de "Descargar / PDF / Ver recibo"
    await page.waitForFunction(
      () => {
        const txt = (el) => (el.textContent || "").toLowerCase();
        return (
          [...document.querySelectorAll("a,button")].some((el) =>
            /descargar|pdf|ver\s*recibo|descarga/i.test(txt(el))
          ) ||
          !!document.querySelector('a[href$=".pdf"], a[href*=".pdf"]')
        );
      },
      { timeout: 120000 }
    );

    // --- Estrategia A: evento de descarga nativo ---
    const downloadPromise = page.waitForEvent("download", { timeout: 120000 }).catch(() => null);

    // Intentar clicks en botones/enlaces de descarga (varias variantes)
    const candidates = page.locator(
      [
        'a:has-text("Descargar")',
        'button:has-text("Descargar")',
        'a:has-text("PDF")',
        'button:has-text("PDF")',
        'a:has-text("Ver recibo")',
        'button:has-text("Ver recibo")',
        'a[href$=".pdf"]',
        'a[href*=".pdf"]',
      ].join(", ")
    );
    const count = await candidates.count();
    for (let i = 0; i < Math.min(count, 6); i++) {
      try {
        await candidates.nth(i).click({ force: true });
        // dar chance a que dispare download
        await page.waitForTimeout(1500);
      } catch {}
    }

    const download = await downloadPromise;

    if (download) {
      // ¡Descarga nativa capturada!
      const suggested = download.suggestedFilename() || "recibo.pdf";
      const stream = await download.createReadStream();
      if (stream) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${suggested}"`);
        // stream -> response
        stream.pipe(res);
        await stream.on("end", async () => {
          try { await browser.close(); } catch {}
        });
        return;
      }
      // fallback si no hay stream (muy raro): guardar y leer
      const tmpPath = `/tmp/${Date.now()}_${suggested}`;
      await download.saveAs(tmpPath);
      const fs = await import("fs");
      const buf = fs.readFileSync(tmpPath);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${suggested}"`);
      res.send(buf);
      await browser.close();
      return;
    }

    // --- Estrategia B: PDF detectado por el sniffer de respuestas ---
    if (sniffedPdf) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${sniffedName}"`);
      res.send(sniffedPdf);
      await browser.close();
      return;
    }

    // --- Estrategia C (último recurso): buscar enlace PDF y hacer fetch en el navegador ---
    const info = await page.evaluate(async () => {
      const abToBase64 = (ab) => {
        const bytes = new Uint8Array(ab);
        const chunk = 0x8000;
        let binary = "";
        for (let i = 0; i < bytes.length; i += chunk) {
          const sub = bytes.subarray(i, i + chunk);
          binary += String.fromCharCode.apply(null, sub);
        }
        return btoa(binary);
      };
      const fetchPdf = async (url) => {
        const r = await fetch(url, { credentials: "include" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const buf = await r.arrayBuffer();
        return abToBase64(buf);
      };
      // Priorizar enlaces cercanos a “recibo / factura / descargar”
      const links = Array.from(document.querySelectorAll('a[href*=".pdf"]'));
      const preferred = links.find((a) =>
        /recibo|factura|descarg/i.test((a.textContent || "") + " " + (a.getAttribute("href") || ""))
      );
      const pick = preferred || links[0];
      if (pick) {
        const href = new URL(pick.getAttribute("href"), location.href).href;
        const b64 = await fetchPdf(href);
        return { ok: true, b64, name: href.split("/").pop() || "recibo.pdf" };
      }
      return { ok: false };
    });

    await browser.close();

    if (info?.ok) {
      const pdf = Buffer.from(info.b64, "base64");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${info.name}"`);
      return res.send(pdf);
    }

    return res.status(404).send("No se encontró el enlace real de descarga del recibo.");
  } catch (e) {
    return res.status(500).send("Error: " + (e?.message || e));
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Calidda service listening on", port));
