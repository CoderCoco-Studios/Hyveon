import { buildLambda } from '../buildLambda.mjs';

await buildLambda({ packageDir: import.meta.dirname, external: ['@aws-sdk/*'] });
