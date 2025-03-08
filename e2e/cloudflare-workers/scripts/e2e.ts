import { runTests } from '@e2e/shared-scripts';
import { createCfDeployment } from './createCfDeployment';

runTests(createCfDeployment('cloudflare-workers'))
  .then(() => {
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
