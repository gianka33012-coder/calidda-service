import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const API_KEY = process.env.API_KEY || "gttherefast";

app.get("/", (_req, res) => res.type("text/plain").send("OK /"));
app.get("/status", (_req, res) => res.json({ ok: true }));
app.get("/descargar", (_req, res) => res.status(405).send("Usa POST /descargar"));

app.post("/descargar", async (req, res) => {
  const providedKey = (req.headers["x-api-key"] || req.body?.api_key || "").toString();
  if (providedKey !== API_KEY) return res.status(401).send("Unauthorized");

  const { numero_cliente, tipo_doc = "DNI", numero_doc, anio, mes } = req.body || {};
  if (!numero_cliente || !numero_doc) return res.status(400).send("Faltan datos: numero_cliente y numero_doc");

  const attemptOnce = async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--no-zygote","--single-process"]
    });

    const ctx = await browser.newContext({ acceptDownloads: true });
    ctx.setDefaultTimeout(180000);
    ctx.setDefaultNavigationTimeout(180000);

    const page = await ctx.newPage();

    // ===== helpers =====
    const up = s => (s || "").toUpperCase();
    async function setBySelectors(pos, val){
      for (const sel of pos) {
        const loc = page.locator(sel);
        if (await loc.count()) {
          try { await loc.first().fill(String(val)); return true; } catch {}
        }
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
    async function gentleScroll(scope, steps = 6, delta = 600, pause = 400){
      for (let i=0;i<steps;i++){
        await scope.evaluate(d => window.scrollBy(0,d), delta).catch(()=>{});
        await scope.waitForTimeout(pause);
      }
    }
    async function findByTextNearNumber(scope, numero, btnSelector){
      // Busca un contenedor que contenga el número y dentro un botón compatible
      const cont = scope.locator(
        'tr, .card, .resultado, .result, .row, li, article, section, .list-item, .table, .table-row'
      ).filter({ hasText: numero }).first();
      if (await cont.count()) {
        const btn = cont.locator(btnSelector).first();
        if (await btn.count()) return btn;
      }
      return null;
    }
    const BTN_SEL =
      [
        `xpath=.//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),'descargar') and (self::a or self::button)]`,
        `xpath=.//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),'recibo') and (self::a or self::button)]`,
        `xpath=.//*[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),'imprimir') and (self::a or self::button)]`,
        `css=a[href$=".pdf"]`,
        `css=a[href*=".pdf"]`,
      ].join(", ");

    // ===== navegación =====
    await page.goto("https://www.calidda.com.pe/atencion-al-cliente/descarga-tu-recibo", { waitUntil: "domcontentloaded" });

    // Completar form
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

    // Consultar
    const btnConsultar = page.locator([
      'button:has-text("Consultar")','button:has-text("Buscar")','a:has-text("Consultar")',
      'a:has-text("Buscar")','button[type="submit"]','input[type="submit"]'
    ].join(", "));
    if (await btnConsultar.count()) {
      await Promise.all([page.waitForLoadState("domcontentloaded"), btnConsultar.first().click()]);
    }

    // “Sniffer” de PDF por XHR/fetch
    let sniffedPdf = null, sniffedName = `recibo_${numero_cliente}.pdf`;
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

    // Intento A: localizar botón dentro de la fila/tarjeta que contenga el número
    let scope = page;
    // Autoscroll y exploración suave
    for (let round=0; round<2; round++){
      // ¿botón dentro de la fila con el número?
      const btnNear = await findByTextNearNumber(scope, numero_cliente, BTN_SEL);
      if (btnNear) {
        const downloadPromise = scope.waitForEvent("download", { timeout: 120000 }).catch(()=>null);
        await btnNear.click({force:true});
        const download = await downloadPromise;
        if (download) {
          const suggested = download.suggestedFilename() || `recibo_${numero_cliente}.pdf`;
          const stream = await download.createReadStream();
          if (stream) {
            res.setHeader("Content-Type","application/pdf");
            res.setHeader("Content-Disposition",`attachment; filename="${suggested}"`);
            stream.pipe(res);
            await new Promise(r=>stream.on("end", r));
            await browser.close();
            return true;
          }
          const tmpPath = `/tmp/${Date.now()}_${suggested}`;
          await download.saveAs(tmpPath);
          const fs = await import("fs");
          const buf = fs.readFileSync(tmpPath);
          res.setHeader("Content-Type","application/pdf");
          res.setHeader("Content-Disposition",`attachment; filename="${suggested}"`);
          res.send(buf);
          await browser.close();
          return true;
        }
        // si no hubo download nativo, esperar por el sniffer
        await page.waitForTimeout(2500);
        if (sniffedPdf) {
          res.setHeader("Content-Type","application/pdf");
          res.setHeader("Content-Disposition",`attachment; filename="${sniffedName}"`);
          res.send(sniffedPdf);
          await browser.close();
          return true;
        }
      }

      // si aún nada, plan B local: botón global “descargar/recibo/pdf/imprimir”
      const globalBtn = scope.locator(BTN_SEL).filter({ hasText: /(descargar|recibo|pdf|imprimir)/i }).first();
      if (await globalBtn.count()) {
        const downloadPromise = scope.waitForEvent("download", { timeout: 120000 }).catch(()=>null);
        await globalBtn.click({force:true});
        const download = await downloadPromise;
        if (download) {
          const suggested = download.suggestedFilename() || `recibo_${numero_cliente}.pdf`;
          const stream = await download.createReadStream();
          if (stream) {
            res.setHeader
