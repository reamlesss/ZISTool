import { handleApiRequest } from "../lib/api-handler.mjs";

export const config = {
  maxDuration: 30,
};

export default async function handler(req, res) {
  await handleApiRequest(req, res);
}