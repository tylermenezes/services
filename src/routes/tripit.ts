import { Router } from 'express';
import config from '@/config';
import { tripit } from '@/clients';

const router = Router();
const tripItSecrets: Record<string, string> = {};

router.get(`/tripit/login/${config.app.secret}`, async (req, res) => {
  const [token, secret] = await tripit.getRequestToken();
  tripItSecrets[token] = secret;
  res.redirect(`https://www.tripit.com/oauth/authorize?oauth_token=${token}&oauth_callback=https://svc.tyler.vc/tripit/login/${config.app.secret}/return/${token}`);
});

router.get(`/tripit/login/${config.app.secret}/return/:token`, async (req, res) => {
  const requestSecret = tripItSecrets[req.params.token];
  const [token, secret] = await tripit.getAccessToken(req.params.token, requestSecret);
  config.tripit.accessToken = token;
  config.tripit.accessTokenSecret = secret;

  res
    .header('Content-type', 'text/plain')
    .send(`TRIPIT_ACCESS_TOKEN=${token}\nTRIPIT_ACCESS_TOKEN_SECRET=${secret}`);
});

export default router;
