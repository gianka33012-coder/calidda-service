import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const API_KEY = process.env.API_KEY || "gttherefast";

app.get("/", (_req, res) => res.type("text/plain").send("OK /"));
app.get("/status", (_req, res) => res.json({ ok: true }));
app.get("/descargar", (_req, res) => res.status(405).type("text/plain").send("Usa POST /descargar"));

app.post("/descargar", async (req, res) => {
  if ((req.headers["x-api-key"] || "") !== API_KEY) return res.status(401).send("Unauthorized");

  const { numero_cliente, tipo_doc = "DNI", numero_doc, anio, mes } = req.body || {};
  if (!numero_cliente || !numero_doc) return res.status(400).send("Faltan datos: numero_cliente y numero_doc");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--no-zygote","--single-process"]
  });

  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();

  // 1) Ir a la página
  await page.goto("https://www.calidda.com.pe/atencion-al-cliente/descarga-tu-recibo", { waitUntil: "domcontentloaded" });

  // Helpers
  const up = s => (s || "").toUpperCase();
  async function setBySelectors(pos, val){
    for (const sel of pos) {
      const loc = page.locator(sel);
      if (await loc.count()) { try { await loc.first().fill(String(val)); return true; } catch {} }
    }
    return false;
  }
  async function selectByTextOrValue(sel, wanted){
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

  // 3) Consultar
  const btnConsultar = page.locator([
    'button:has-text("Consultar")','button:has-text("Buscar")','a:has-text("Consultar")',
    'a:has-text("Buscar")','button[type="submit"]','input[type="submit"]'
  ].join(", "));
  if (await btnConsultar.count()) {
    await Promise.all([page.waitForLoadState("networkidle"), btnConsultar.first().click()]);
  }

  // 4) Esperar resultados y localizar la FILA/TARJETA que contenga el número de cliente
  const numeroBuscado = numero_cliente.trim();
  await page.waitForFunction((num) => {
    const txt = n => (n.textContent || "").toUpperCase();
    const nodes = document.querySelectorAll("tr, .card, .resultado, .result, .row, li, article, section, .list-item");
    return [...nodes].some(n => txt(n).includes(num.toUpperCase()));
  }, numeroBuscado, { timeout: 120000 });

  // Elegir el contenedor correcto (la primera coincidencia con el número)
  const contenedor = page.locator('tr, .card, .resultado, .result, .row, li, article, section, .list-item')
                         .filter({ hasText: numeroBuscado }).first();

  // Si ese contenedor está dentro de un iframe, moverse al frame
  let scope = page;
  const frame = await contenedor.frameLocator?.() ?? null; // compat
  try {
    // Si el elemento vive en un frame, localizar el frame real con hasText
    const frames = page.frames();
    for (const f of frames) {
      if (await f.locator('body').innerText().catch(()=>'')) {
        const has = await f.evaluate((num) =>
          [...document.querySelectorAll("tr, .card, .resultado, .result, .row, li, article, section, .list-item")]
            .some(n => (n.textContent||"").toUpperCase().includes(num.toUpperCase())),
          numeroBuscado
        ).catch(()=>false);
        if (has) { scope = f; break; }
      }
    }
  } catch {}

  // 5) Dentro del contenedor correcto, buscar el botón/enlace de descarga
  const descargarEnContenedor = scope.locator([
    // dentro de la fila/tarjeta que contiene el número de cliente
    `:scope >> xpath=.//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),'descargar') and (self::a or self::button)]`,
    `:scope >> xpath=.//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),'ver recibo') and (self::a or self::button)]`,
    `:scope >> css=a[href$=".pdf"]`,
    `:scope >> css=a[href*=".pdf"]`
  ].join(", ")).filter({ hasText: /(descargar|recibo|pdf)/i }).first();

  // 6) Capturar descarga nativa
  const downloadPromise = scope.waitForEvent("download", { timeout: 120000 }).catch(() => null);

  // 7) Click en el botón/enlace DENTRO del contenedor que corresponde al número
  let clicked = false;
  if (await descargarEnContenedor.count()) {
    await descargarEnContenedor.click({ force: true });
    clicked = true;
  }

  // Si no había botón claro, como último recurso prueba el primer enlace .pdf dentro del contenedor
  if (!clicked) {
    const pdfLink = scope.locator(`:scope >> xpath=.//a[contains(@href,'.pdf')]`).first();
    if (await pdfLink.count()) {
      await pdfLink.click({ force: true });
      clicked = true;
    }
  }

  // 8) Si no se pudo clickear nada específico, error
  if (!clicked) {
    await browser.close();
    return res.status(404).send("No se encontró el botón/enlace de descarga en la fila del cliente.");
  }

  // 9) Esperar la descarga
  const download = await downloadPromise;

  // Si hubo descarga nativa, entregar ese PDF
  if (download) {
    const suggested = download.suggestedFilename() || `recibo_${numeroBuscado}.pdf`;
    const stream = await download.createReadStream();
    if (stream) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${suggested}"`);
      stream.pipe(res);
      await new Promise(r => stream.on("end", r));
      await browser.close();
      return;
    }
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

  // 10) Si no hubo evento de descarga (algunos sitios abren PDF en la misma pestaña o XHR),
  //     interceptar respuestas PDF posteriores al click
  let fallbackPdf = null, fallbackName = `recibo_${numeroBuscado}.pdf`;
  page.on("response", async (resp) => {
    try {
      const ct = resp.headers()["content-type"] || "";
      if (ct.includes("application/pdf") && !fallbackPdf) {
        const url = resp.url();
        const body = await resp.body();
        fallbackPdf = Buffer.from(body);
        const tail = url.split("/").pop() || "";
        if (tail.toLowerCase().endsWith(".pdf")) fallbackName = tail;
      }
    } catch {}
  });

  // Espera breve por si la respuesta llega como XHR/fetch
  await scope.waitForTimeout(3500);

  if (fallbackPdf) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fallbackName}"`);
    res.send(fallbackPdf);
    await browser.close();
    return;
  }

  await browser.close();
  return res.status(404).send("No se pudo capturar el PDF del recibo (descarga o respuesta PDF no detectadas).");
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Calidda service listening on", port));
