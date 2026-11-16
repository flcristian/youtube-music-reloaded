import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { backend } from './backend';
import { renderer } from './renderer';

export default createPlugin({
  name: () => t('plugins.mcp-bridge.name'),
  description: () => t('plugins.mcp-bridge.description'),
  restartNeeded: true,
  config: { enabled: true },
  backend,
  renderer,
});
