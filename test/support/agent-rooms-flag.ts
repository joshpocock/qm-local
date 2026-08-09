// The /v1/agents route table is built from the environment when
// src/api/routes/index.ts is first evaluated, so this must be imported before
// anything that pulls in the server. Node runs each test file in its own
// process, so setting it here only affects the importing file.
process.env.QM_AGENT_ROOMS = "1";
