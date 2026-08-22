// The template pack used when none is configured — i.e. a plain clone of this
// repository, which is the supported default. See lib/export/pdf/pack.ts.

import type { TemplatePack } from './types';

const pack: TemplatePack = {
  name: 'none',
  templates: [],
};

export default pack;
