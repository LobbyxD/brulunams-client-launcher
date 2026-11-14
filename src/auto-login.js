"use strict";
function validateTicketEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Auto-login requires an HTTPS account endpoint.");
  return url;
}
function createLoginEnvironment(environment, handoff) {
  const result = { ...environment };
  delete result.BRULUNA_LOGIN_ACCOUNT; delete result.BRULUNA_LOGIN_TICKET;
  if (!handoff) return result;
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(handoff.account || "") || !/^[A-Za-z0-9]{12}$/.test(handoff.ticket || "")) throw new Error("Invalid auto-login handoff.");
  result.BRULUNA_LOGIN_ACCOUNT = handoff.account;
  result.BRULUNA_LOGIN_TICKET = handoff.ticket;
  return result;
}
module.exports = { validateTicketEndpoint, createLoginEnvironment };
