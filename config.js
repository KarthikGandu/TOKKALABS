// Shared constants only (ports + seed identifiers). No runtime state is shared
// between services; each service keeps its own data in memory.
module.exports = {
  PORTS: { ap: 3000, alpaca: 4000, issuer: 5000 },
  URLS: {
    ap: 'http://localhost:3000',
    alpaca: 'http://localhost:4000',
    issuer: 'http://localhost:5000',
  },
  IDS: {
    AP_ACCOUNT: 'ap-account-001',          // AP's brokerage account at Alpaca
    ISSUER_ACCOUNT: 'xstocks-custody-001', // Issuer's custody account at Alpaca
    AP_ID: 'ap-001',                       // AP's registration id at the Issuer
    ISSUER_ID: 'xstocks',
    AP_WALLET: 'ApWa11etSo1anaAddressWhiteListed111111111111111',
    REDEMPTION_WALLET: 'XstocksRedemption1Wa11etSo1ana1111111111111',
  },
  // Static key the Issuer requires in X-API-KEY on every endpoint except /health. Override with env ISSUER_API_KEY.
  ISSUER_API_KEY: process.env.ISSUER_API_KEY || 'issuer-secret-key',
};
