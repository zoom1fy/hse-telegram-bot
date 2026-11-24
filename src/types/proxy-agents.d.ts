// Пакеты https-proxy-agent/socks-proxy-agent отдают типы только через "exports",
// а в проекте moduleResolution: "node". Объявляем минимально нужные типы сами.
declare module 'https-proxy-agent' {
  import { Agent } from 'http';
  export class HttpsProxyAgent extends Agent {
    constructor(proxy: string | URL);
  }
}

declare module 'socks-proxy-agent' {
  import { Agent } from 'http';
  export class SocksProxyAgent extends Agent {
    constructor(proxy: string | URL);
  }
}
