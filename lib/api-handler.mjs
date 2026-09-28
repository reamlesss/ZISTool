import https from "node:https";
import { readFileSync } from "node:fs";

const apiHost = "api.uzis.cz";
const clientCertificateConfigured = Boolean(
  process.env.PFX_BASE64 || process.env.PFX_PATH
);
const agentOptions = {};

if (process.env.PFX_BASE64) {
  agentOptions.pfx = Buffer.from(process.env.PFX_BASE64.replace(/\s/g, ""), "base64");
} else if (process.env.PFX_PATH) {
  agentOptions.pfx = readFileSync(process.env.PFX_PATH);
}

if (process.env.PFX_PASSWORD) {
  agentOptions.passphrase = process.env.PFX_PASSWORD;
}

const agent = new https.Agent(agentOptions);

function sendJson(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

async function readJsonBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === "string" || Buffer.isBuffer(req.body)) {
      return parseJson(req.body.toString("utf8"));
    }
    return req.body;
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return parseJson(Buffer.concat(chunks).toString("utf8"));
}

function isValidText(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 100 &&
    !/[\u0000-\u001f]/.test(value)
  );
}

function isValidBirthDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) {
    return false;
  }

  const birthDate = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(birthDate.getTime()) &&
    birthDate.toISOString().slice(0, 10) === value
  );
}

function getWorkerConfig() {
  return {
    nrzpCislo:
      process.env.WORKER_NRZP_CISLO ||
      (process.env.VERCEL ? "" : "123456789"),
    pcz: process.env.PCZ || (process.env.VERCEL ? "" : "013"),
  };
}

function sendUpstream(res, { apiPath, method = "GET", body }) {
  const options = {
    hostname: apiHost,
    path: apiPath,
    method,
    agent,
    headers: {
      accept: "application/json",
      ...(body
        ? {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          }
        : {}),
    },
    timeout: Number(process.env.UPSTREAM_TIMEOUT_MS || 20_000),
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
    console.error("UZIS upstream request failed:", error.message);
    sendJson(res, 502, {
      error: isTlsError
        ? "TLS connection failed. Check the configured client certificate."
        : "Could not reach the API.",
      ...(process.env.VERCEL
        ? {}
        : { detail: error.message, clientCertificateConfigured }),
    });
  });

  upstream.end(body);
}

export async function handleApiRequest(req, res) {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/api/status") {
    sendJson(res, 200, {
      ready: true,
      clientCertificateConfigured,
    });
    return;
  }

  const isIdLookup = url.pathname === "/api/patient";
  const isNameLookup = url.pathname === "/api/patient/search";
  const isInsuranceUpdate = url.pathname === "/api/patient/insurance-number";
  const isKnownRoute = isIdLookup || isNameLookup || isInsuranceUpdate;

  if (!isKnownRoute) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

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

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    sendJson(res, 400, { error: "Request body must be a JSON object." });
    return;
  }

  const { nrzpCislo, pcz } = getWorkerConfig();
  if (process.env.VERCEL && (!nrzpCislo || !pcz)) {
    sendJson(res, 500, {
      error: "Set WORKER_NRZP_CISLO and PCZ in the deployment environment.",
    });
    return;
  }

  if (isIdLookup) {
    const pacientId = typeof input.pacientId === "string"
      ? input.pacientId.trim()
      : "";
    if (!isValidText(pacientId)) {
      sendJson(res, 400, { error: "Provide a valid pacientId." });
      return;
    }

    sendUpstream(res, {
      apiPath: `/api/v1/pacienti/VyhledatPacientaDleId/${encodeURIComponent(
        pacientId
      )}?pcz=${encodeURIComponent(pcz)}`,
    });
    return;
  }

  if (isNameLookup) {
    const { jmeno, prijmeni, datumNarozeni } = input;
    if (
      !isValidText(jmeno) ||
      !isValidText(prijmeni) ||
      !isValidBirthDate(datumNarozeni)
    ) {
      sendJson(res, 400, {
        error: "Provide valid jmeno, prijmeni, and YYYY-MM-DD datumNarozeni values.",
      });
      return;
    }

    sendUpstream(res, {
      apiPath: `/api/v1/pacienti/VyhledatSeznamDleJmenoPrijmeniDatumNarozeni/${encodeURIComponent(
        jmeno.trim()
      )}/${encodeURIComponent(prijmeni.trim())}/${encodeURIComponent(
        datumNarozeni
      )}T00:00:00?pracovnikNrzpCislo=${encodeURIComponent(
        nrzpCislo
      )}&pcz=${encodeURIComponent(pcz)}`,
    });
    return;
  }

  const pacientId = typeof input.pacientId === "string"
    ? input.pacientId.trim()
    : "";
  const cisloPojistence = typeof input.cisloPojistence === "string"
    ? input.cisloPojistence.trim()
    : "";
  const { datumNarozeni } = input;

  if (
    !isValidText(pacientId) ||
    !isValidText(cisloPojistence) ||
    !isValidBirthDate(datumNarozeni)
  ) {
    sendJson(res, 400, {
      error:
        "Provide valid pacientId, cisloPojistence, and YYYY-MM-DD datumNarozeni values.",
    });
    return;
  }

  const body = JSON.stringify({
    pracovnik: {
      nrzpCislo,
      rodneCislo: null,
      pcz,
      jmeno: null,
      prijmeni: null,
      titulPred: null,
      titulZa: null,
    },
    pacientId,
    cisloPojistence,
    datumNarozeni: `${datumNarozeni}T00:00:00`,
  });

  sendUpstream(res, {
    apiPath: "/api/v1/pacienti/AktualizujCisloPojistence",
    method: "POST",
    body,
  });
}