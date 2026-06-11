const https = require('https');
const http = require('http');
const axios = require('axios');

const sslInsecureDev = process.env.SSL_INSECURE_DEV === 'true';

const httpsAgent = new https.Agent({
  rejectUnauthorized: !sslInsecureDev
});

const httpClient = axios.create({
  timeout: 15000,
  httpsAgent,
  httpAgent: new http.Agent()
});

module.exports = { httpClient, httpsAgent, sslInsecureDev };
