import { buildLambda } from '../buildLambda.mjs';

await buildLambda({ external: ['@aws-sdk/*'] });
