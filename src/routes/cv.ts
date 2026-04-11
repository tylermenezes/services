import { Router } from "express";
import { fetchCv, fetchCvTex } from "@/datasources";
import { DateTime } from "luxon";
import { promises as fs } from "fs";
import path from "path";
import config from "@/config";

const CV_TEMPLATE_FILE = path.join(process.cwd(), "templates", "cv.tex");

const router = Router();

router.get("/cv.json", async (_, res) => {
  res.send(await fetchCv());
});

router.get("/cv.tex", async (_, res) => {
  res.setHeader("Content-type", "text/plain").send(await fetchCvTex());
});

router.get("/cv-full.tex", async (_, res) => {
  const cvContent = await fetchCvTex();
  if (!cvContent) {
    res.status(500).send("Could not generate CV content.");
    return;
  }

  const date = DateTime.now().toLocaleString({
    month: "long",
    year: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  const cvTemplate = await fs.readFile(CV_TEMPLATE_FILE, "utf-8");
  const rendered = cvTemplate
    .replace("{{cvContent}}", cvContent)
    .replace("{{date}}", date);

  res.setHeader("Content-type", "text/plain").send(rendered);
});

let pdfCache: { buffer: Buffer; cachedAt: DateTime } | null = null;

router.get("/cv.pdf", async (req, res) => {
  const isFreshRequested = req.query.fresh === "true";
  const isCacheExpired =
    !pdfCache || DateTime.now().diff(pdfCache.cachedAt, "minutes").minutes > 60;

  if (isFreshRequested || isCacheExpired) {
    try {
      const pdf = await fetch(
        `${config.texServer}/compile?url=https://svc.tyler.vc/cv-full.tex`,
      );
      if (pdf.ok) {
        const buffer = Buffer.from(await pdf.arrayBuffer());
        if (buffer.byteLength > 1024) {
          pdfCache = { buffer, cachedAt: DateTime.now() };
        }
      }
    } catch (ex) {}
  }

  if (!pdfCache) {
    res.status(500).send("Could not generate PDF.");
    return;
  }

  res.setHeader("Content-type", "application/pdf");
  res.send(pdfCache.buffer);
});

export default router;
