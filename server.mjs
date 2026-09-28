import https from "node:https";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const host = "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const apiHost = "api.uzis.cz";

const agentOptions = {};

if (process.env.PFX_PATH) {
  agentOptions.pfx = readFileSync(process.env.PFX_PATH);

  if (process.env.PFX_PASSWORD) {
    agentOptions.passphrase = process.env.PFX_PASSWORD;
  }
}

const agent = new https.Agent(agentOptions);

function sendJson(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) {
      tooLarge = true;
    } else {
      chunks.push(chunk);
    }
  }

  if (tooLarge) {
    const error = new Error("Request body is too large.");
    error.statusCode = 413;
    throw error;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(readFileSync(join(here, "public", "index.html")));
    return;
  }

  if (req.method === "GET" && url.pathname === "/style.css") {
    res.writeHead(200, {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(readFileSync(join(here, "public", "style.css")));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    sendJson(res, 200, {
      ready: true,
      clientCertificateConfigured: Boolean(process.env.PFX_PATH),
    });
    return;
  }

  const isIdLookup = url.pathname === "/api/patient";
  const isNameLookup = url.pathname === "/api/patient/search";
  const isInsuranceUpdate = url.pathname === "/api/patient/insurance-number";

  let apiPath;
  let apiMethod = "GET";
  let apiBody;

  if (isInsuranceUpdate && req.method === "POST") {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) {
      sendJson(res, 415, { error: "Content-Type must be application/json." });
      return;
    }

    let input;
    try {
      input = await readJsonBody(req);
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
      return;
    }

    const pacientId =
      typeof input?.pacientId === "string" ? input.pacientId.trim() : "";
    const cisloPojistence =
      typeof input?.cisloPojistence === "string"
        ? input.cisloPojistence.trim()
        : "";
    const datumNarozeni = input?.datumNarozeni;
    const validText = (value) =>
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 100 &&
      !/[\u0000-\u001f]/.test(value);
    const birthDate = new Date(`${datumNarozeni}T00:00:00Z`);
    const validBirthDate =
      /^\d{4}-\d{2}-\d{2}$/.test(datumNarozeni || "") &&
      !Number.isNaN(birthDate.getTime()) &&
      birthDate.toISOString().slice(0, 10) === datumNarozeni;

    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      !validText(pacientId) ||
      !validText(cisloPojistence) ||
      !validBirthDate
    ) {
      sendJson(res, 400, {
        error:
          "Provide valid pacientId, cisloPojistence, and YYYY-MM-DD datumNarozeni values.",
      });
      return;
    }

    apiPath = "/api/v1/pacienti/AktualizujCisloPojistence";
    apiMethod = "POST";
    apiBody = JSON.stringify({
      pracovnik: {
        nrzpCislo: "123456789",
        rodneCislo: null,
        pcz: "013",
        jmeno: null,
        prijmeni: null,
        titulPred: null,
        titulZa: null,
      },
      pacientId,
      cisloPojistence,
      datumNarozeni: `${datumNarozeni}T00:00:00`,
    });
  } else if (req.method === "GET" && isIdLookup) {
    const pacientId = url.searchParams.get("pacientId")?.trim();

    if (
      !pacientId ||
      pacientId.length > 100 ||
      /[\u0000-\u001f]/.test(pacientId)
    ) {
      sendJson(res, 400, {
        error: "Provide a valid pacientId query parameter.",
      });
      return;
    }

    apiPath = `/api/v1/pacienti/VyhledatPacientaDleId/${encodeURIComponent(
      pacientId
    )}?pcz=013`;
  } else if (req.method === "GET" && isNameLookup) {
    const jmeno = url.searchParams.get("jmeno")?.trim();
    const prijmeni = url.searchParams.get("prijmeni")?.trim();
    const datumNarozeni = url.searchParams.get("datumNarozeni");
    const validName = (value) =>
      value && value.length <= 100 && !/[\u0000-\u001f]/.test(value);
    const birthDate = new Date(`${datumNarozeni}T00:00:00Z`);
    const validBirthDate =
      /^\d{4}-\d{2}-\d{2}$/.test(datumNarozeni || "") &&
      !Number.isNaN(birthDate.getTime()) &&
      birthDate.toISOString().slice(0, 10) === datumNarozeni;

    if (!validName(jmeno) || !validName(prijmeni) || !validBirthDate) {
      sendJson(res, 400, {
        error: "Provide valid jmeno, prijmeni, and datumNarozeni values.",
      });
      return;
    }

    apiPath = `/api/v1/pacienti/VyhledatSeznamDleJmenoPrijmeniDatumNarozeni/${encodeURIComponent(
      jmeno
    )}/${encodeURIComponent(prijmeni)}/${encodeURIComponent(
      datumNarozeni
    )}T00:00:00?pracovnikNrzpCislo=123456789&pcz=013`;
  } else {
    const knownRoute = isIdLookup || isNameLookup || isInsuranceUpdate;
    sendJson(res, knownRoute ? 405 : 404, {
      error: knownRoute ? "Method not allowed." : "Not found",
    });
    return;
  }

  const options = {
    hostname: apiHost,
    path: apiPath,
    method: apiMethod,
    agent,
    headers: {
      accept: "application/json",
      ...(apiBody
        ? {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(apiBody),
          }
        : {}),
    },
    timeout: 20_000,
  };

  const upstream = https.request(options, (apiRes) => {
    const chunks = [];

    apiRes.on("data", (chunk) => chunks.push(chunk));

    apiRes.on("end", () => {
      res.writeHead(apiRes.statusCode || 502, {
        "content-type":
          apiRes.headers["content-type"] || "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(Buffer.concat(chunks));
    });
  });

  upstream.on("timeout", () => {
    upstream.destroy(new Error("API request timed out"));
  });

  upstream.on("error", (error) => {
    const isTlsError = /certificate|tls|ssl|handshake|alert/i.test(
      error.message
    );

    sendJson(res, 502, {
      error: isTlsError
        ? "TLS connection failed. The API may require a client certificate, or the configured PFX may be invalid."
        : "Could not reach the API.",
      detail: error.message,
      clientCertificateConfigured: Boolean(process.env.PFX_PATH),
    });
  });

  upstream.end(apiBody);
});

server.listen(port, host, () => {
  console.log(`Local API client: http://${host}:${port}`);
  console.log(
    `Client certificate configured: ${Boolean(process.env.PFX_PATH)}`
  );
});