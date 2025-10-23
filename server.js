import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// === CONFIG ===
const API_KEY = process.env.API_KEY || "gttherefast";
const ORIGIN_ALLOW = null; // por ejemplo: "https://yefany.repuestosdiaz.store"  (déjalo null si no quieres validar)
// =================

// Rutas de health
app.get("/", (_req, res) => res.type("text/plain").send("OK /"));
app.get("/status", (_req, res) => res.json({ ok: true }));

// Solo POST para descargar
app.get("/descargar", (_req, res) =>
  res.status(405).type("text/plain").send("Usa POST /descargar")
);

app.post("/descargar", async (req, res) => {
  try {
    // 1) Seguridad básica: API key por header o por body
    const providedKey = (req.headers["x-api-key"] || req.body?.api_key || "").toString();
    if (providedKey !== API_KEY) {
      return res.status(401).send("Unauthorized");
    }

    // (Opcional) Restringir por origen
    if (ORIGIN_ALLOW) {
      const origin = (req.headers.origin || req.headers.referer || "").toString();
      if (!origin.startsWith(ORIGIN_ALLOW)) {
        return res.status(403).send("Forbidden origin");
      }
    }

    // 2) Datos del formulario
    const {
      numero_cliente,
      tipo_doc = "DNI",
      numero_doc,
      anio,
      mes,
    } = req.body || {};

    if (!numero_cliente || !numero_doc) {
      return res.status(400).send("Faltan datos: numero_cliente y numero_doc");
    }

    // 3) Lanzar Playwright
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
    ctx.setDefaultTimeout(120000);           // acciones
    ctx.setDefaultNavigationTimeout(120000); // navegaciones

    const page = await ctx.newPage();

    // 4) Ir a la página de Cálidda
    await page.goto(
      "https://www.calidda.com.pe/atencion-al-cliente/descarga-tu-recibo",
      { waitUntil: "domcontentloaded" }
    );

    // Helpers
    const up = (s) => (s || "").toUpperCase();
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

    // 5) Completar formulario
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
      await selectByTextOrValue('select[name="mes"], select[name="month"]', String(mes).padStart(2, "0"));

    // 6) Consultar
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

    // 7) Esperar a que aparezcan resultados con el número de cliente
    const numeroBuscado = numero_cliente.trim();
    await page.waitForFunction(
      (num) => {
        const txt = (n) => (n.textContent || "").toUpperCase();
        const nodes = document.querySelectorAll(
          "tr, .card, .resultado, .result, .row, li, article, section, .list-item, .table, .table-row"
        );
        return [...nodes].some((n) => txt(n).includes(num.toUpperCase()));
      },
      numeroBuscado,
      { timeout: 120000 }
    );

    // 8) Buscar el contenedor exacto que contiene el número y, dentro, el botón/enlace de descarga
    //    (de esta forma evitamos PDFs genéricos del sitio)
    const contenedor = page
      .locator(
        'tr, .card, .resultado, .result, .row, li, article, section, .list-item, .table, .table-row'
      )
      .filter({ hasText: numeroBuscado })
      .first();

    // Para casos raros con iframes: intentamos determinar el frame correcto
    let scope = page;
    try {
      for (const f of page.frames()) {
        const ok = await f
          .evaluate((num) => {
            const txt = (n) => (n.textContent || "").toUpperCase();
            return [...document.querySelectorAll("body *")].some((n) =>
              txt(n).includes(num.toUpperCase())
            );
          }, numeroBuscado)
          .catch(() => false);
        if (ok) {
          scope = f;
          break;
        }
      }
    } catch {}

    // 9) Preparar el “sniffer” de respuestas PDF (fallback si no hay download nativo)
    let sniffedPdf = null;
    let sniffedName = "recibo.pdf";
    scope.on("response", async (resp) => {
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

    // 10) Intentar click SOLO dentro del contenedor del cliente
    const descargarEnContenedor = scope
      .locator(
        [
          `xpath=.//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),'descargar') and (self::a or self::button)]`,
          `xpath=.//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),'ver recibo') and (self::a or self::button)]`,
          `css=a[href$=".pdf"]`,
          `css=a[href*=".pdf"]`,
        ].join(", ")
      )
      .filter({ hasText: /(descargar|recibo|pdf)/i })
      .first();

    const downloadPromise = scope.waitForEvent("download", { timeout: 120000 }).catch(() => null);

    let clicked = false;
    if (await descargarEnContenedor.count()) {
      await descargarEnContenedor.click({ force: true });
      clicked = true;
    } else {
      // último recurso: primer enlace .pdf dentro de ese contenedor
      const pdfLink = contenedor.locator(`xpath=.//a[contains(@href,'.pdf')]`).first();
      if (await pdfLink.count()) {
        await pdfLink.click({ force: true });
        clicked = true;
      }
    }

    if (!clicked) {
      await browser.close();
      return res
        .status(404)
        .send("No se encontró el botón/enlace de descarga en la fila del cliente.");
    }

    // 11) Esperar descarga nativa
    const download = await downloadPromise;

    if (download) {
      // Descarga capturada por Playwright
      const suggested = download.suggestedFilename() || `recibo_${numeroBuscado}.pdf`;
      const stream = await download.createReadStream();
      if (stream) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${suggested}"`);
        stream.pipe(res);
        await new Promise((r) => stream.on("end", r));
        await browser.close();
        return;
      }
      // Raro: sin stream → guardar a tmp y servir
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

    // 12) Fallback: PDF visto por el sniffer de respuestas
    if (sniffedPdf) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${sniffedName}"`);
      res.send(sniffedPdf);
      await browser.close();
      return;
    }

    await browser.close();
    return res
      .status(404)
      .send("No se pudo capturar el PDF del recibo (descarga o respuesta PDF no detectadas).");
  } catch (e) {
    return res.status(500).send("Error: " + (e?.message || e));
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Calidda service listening on", port));
