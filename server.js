import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// API KEY que usarás desde cPanel
const API_KEY = process.env.API_KEY || "gttherefast";

app.get("/", (_req, res) => res.type("text/plain").send("OK /"));
app.get("/status", (_req, res) => res.json({ ok: true }));
app.get("/descargar", (_req, res) => res.status(405).type("text/plain").send("Usa POST /descargar"));

app.post("/descargar", async (req, res) => {
  try {
    if ((req.headers["x-api-key"] || "") !== API_KEY) return res.status(401).send("Unauthorized");

    const { numero_cliente, tipo_doc = "DNI", numero_doc, anio, mes } = req.body || {};
    if (!numero_cliente || !numero_doc) return res.status(400).send("Faltan datos");

    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--no-zygote","--single-process"]
    });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto("https://www.calidda.com.pe/atencion-al-cliente/descarga-tu-recibo", { waitUntil: "domcontentloaded" });

    async function setBySelectors(pos, val){
      for(const sel of pos){ const loc=page.locator(sel); if(await loc.count()){ try{ await loc.first().fill(String(val)); return true; }catch{} } }
      return false;
    }
    async function selectByTextOrValue(sel, wanted){
      const loc = page.locator(sel); if(!(await loc.count())) return false;
      const opts = await loc.first().locator("option").all(); const up = s => (s||"").toUpperCase();
      for(const o of opts){
        const v = up(await o.getAttribute("value")); const t = up(await o.innerText());
        if (v===up(wanted) || t.includes(up(wanted))) {
          await loc.first().selectOption({ value: await o.getAttribute("value") });
          return true;
        }
      }
      return false;
    }

    await setBySelectors(['input[name="numeroCliente"]','input[name="numCliente"]','input[name="nroCliente"]','input[name="numero_cliente"]','input[placeholder*="cliente" i]'], numero_cliente);
    await selectByTextOrValue('select[name="tipoDocumento"], select[name="tipo_doc"], select', tipo_doc);
    await setBySelectors(['input[name="numeroDocumento"]','input[name="nroDocumento"]','input[name="numero_doc"]','input[name="documento"]','input[placeholder*="documento" i]'], numero_doc);
    if (anio) await setBySelectors(['select[name="anio"]','select[name="year"]'], anio);
    if (mes)  await setBySelectors(['select[name="mes"]','select[name="month"]'], String(mes).padStart(2,"0"));

    const btn = page.locator('button:has-text("Consultar"), button:has-text("Buscar"), a:has-text("Consultar"), a:has-text("Buscar")');
    if (await btn.count()) await btn.first().click();

    await page.waitForFunction(() => {
      const hasBtn = [...document.querySelectorAll("a,button")].some(el => /descargar|pdf|ver recibo/i.test(el.textContent||""));
      const link   = document.querySelector('a[href$=".pdf"], a[href*=".pdf"]');
      return hasBtn || !!link;
    }, { timeout: 120000 });

    const info = await page.evaluate(async () => {
      const fetchPdf = async (url) => {
        const r = await fetch(url, { credentials: "include" });
        if (!r.ok) throw new Error("HTTP "+r.status);
        const buf = await r.arrayBuffer();
        return Buffer.from(buf).toString("base64");
      };
      let link = document.querySelector('a[href$=".pdf"], a[href*=".pdf"]');
      if (link) {
        const href = new URL(link.getAttribute("href"), location.href).href;
        const b64 = await fetchPdf(href);
        return { ok:true, b64, name: href.split("/").pop() || "recibo.pdf" };
      }
      const btn = [...document.querySelectorAll("a,button")].find(el => /descargar|pdf|ver recibo/i.test(el.textContent||""));
      if (btn) {
        const near = btn.closest("div,section,article,li")?.querySelector('a[href*=".pdf"]');
        if (near) {
          const href = new URL(near.getAttribute("href"), location.href).href;
          const b64 = await fetchPdf(href);
          return { ok:true, b64, name: href.split("/").pop() || "recibo.pdf" };
        }
        btn.click(); await new Promise(r => setTimeout(r,2000));
        const later = document.querySelector('a[href*=".pdf"]');
        if (later) {
          const href = new URL(later.getAttribute("href"), location.href).href;
          const b64 = await fetchPdf(href);
          return { ok:true, b64, name: href.split("/").pop() || "recibo.pdf" };
        }
      }
      return { ok:false, error:"No encontré enlace de PDF" };
    });

    await browser.close();

    if (!info.ok) return res.status(500).send(info.error || "Error");

    const pdf = Buffer.from(info.b64, "base64");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${info.name}"`);
    res.send(pdf);
  } catch (e) {
    res.status(500).send("Error: " + (e?.message || e));
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Calidda service listening on", port));
