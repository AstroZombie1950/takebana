// Сертификаты для локального HTTPS.
//
// На проде TLS терминирует nginx, и сюда дело не доходит: режим prod поднимает
// обычный http-сервер. Файл нужен только для режима START_SERVER=local.
// Возвращает null, если сертификатов нет — тогда app.js падает обратно на HTTP.

const fs = require('fs');
const path = require('path');

function readTlsOptions() {
  // Пути к сертификатам, которые вы создали с помощью OpenSSL
  let options;
  try {
    // Prefer env-provided paths, then fall back to common local locations.
    const keyCandidates = [
      process.env.SSL_KEY_PATH,
      path.join(__dirname, '..', 'certs', 'localhost-key.pem'),
    ].filter(Boolean);

    const certCandidates = [
      process.env.SSL_CERT_PATH,
      path.join(__dirname, '..', 'certs', 'localhost.pem'),
    ].filter(Boolean);

    const pickFirstReadable = (candidates) => {
      for (const p of candidates) {
        try {
          fs.accessSync(p, fs.constants.R_OK);
          return p;
        } catch (_) {}
      }
      return null;
    };

    const keyPath = pickFirstReadable(keyCandidates);
    const certPath = pickFirstReadable(certCandidates);

    if (!keyPath || !certPath) {
      throw new Error(
        `SSL files not found. Looked for key in: ${keyCandidates.join(', ')}; cert in: ${certCandidates.join(', ')}`
      );
    }

    options = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
    console.log('HTTPS certificates loaded:', { keyPath, certPath });
  } catch (error) {
    console.log('HTTPS certificates not found. HTTPS will be disabled.', error && error.message ? error.message : error);
    options = null;
  }

  return options;
}

module.exports = { readTlsOptions };
