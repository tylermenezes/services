import { Router } from 'express';
import { Readable } from 'stream';
import debug from 'debug';
import config from '@/config';
import { getZoteroFile, getZoteroItem, getZoteroItems } from '@/datasources';

const DEBUG = debug('services:routes:zotero');

const router = Router();

// The library and its files are private, so these routes are behind the app secret.
const base = `/zotero/${config.app.secret}`;

router.get(`${base}/items.json`, (_, res) => {
  res.send(getZoteroItems());
});

router.get(`${base}/items/:key.json`, (req, res) => {
  const item = getZoteroItem(req.params.key);
  if (!item) {
    res.status(404).send('Not found.');
    return;
  }
  res.send(item);
});

router.get(`${base}/items/:key.pdf`, async (req, res) => {
  try {
    const file = await getZoteroFile(req.params.key);
    if (!file) {
      res.status(404).send('No stored file.');
    } else if ('redirect' in file) {
      res.redirect(302, file.redirect);
    } else {
      res.setHeader('Content-type', file.response.headers.get('Content-type') || 'application/pdf');
      Readable.fromWeb(file.response.body as any).pipe(res);
    }
  } catch (ex) {
    DEBUG(ex);
    res.status(502).send('Could not fetch file from Zotero.');
  }
});

export default router;
