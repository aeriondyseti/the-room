# 4.1 acceptance run — four-agent-scenarios

- Started 2026-09-28T13:36:38.242Z · finished 2026-09-28T13:39:13.106Z
- **Throwaway fixture sessions only** (`claude --bg --model haiku` and Codex fixture threads), in a scratch room (C:\Users\Kevin\.claude\jobs\67b7bc1e\tmp\vpfix-four-agent-scenarios-AUWwMY); not Kevin's TUI panes and not our work sessions.
- Fixtures: fxa (claude, 6cff765a), fxb (claude, f26a1f66), fxc (codex, 01a0e83b), fxd (codex, 01a0e83b)
- Latencies are measured from the room message's `createdAt`: **enqueue** = native submit finished (Claude pipe write / `codex queue`), **turn start** = first assistant record after the message entered the transcript, **reply** = the fixture's `room_send` reply (`reply_to` = the message) was created. Stats are p50 / p90 / max.

## Done-when scenarios

| Scenario | Result | Evidence |
|---|---|---|
| broadcast reaches all | ✅ pass | `{"messageId":"m-mulakv0p-6dd16663-c4b3-4aa5-812b-e4c1473da779","recipients":["fxa:replied","fxb:replied","fxc:replied","fxd:replied"],"repliedBy":["fxd","fxc","fxa","fxb"]}` |
| @name reaches only the target | ✅ pass | `{"messageId":"m-mulal71t-ed729b6d-58fa-4cd5-b2cc-a297b65033d1","deliveries":["fxa"],"repliedBy":["fxa"]}` |
| same-harness reply (claude→claude) | ✅ pass | `{"trigger":"m-mulall8p-31fec416-dbd3-47c1-a7a5-a6f531fb8eac","ping":"m-mulaln1p-6753cc78-4565-45fd-bd1a-b20932e6037b","pingIdentity":{"mode":"verified","source":"claude-mcp-registry"},"ack":"m-mulalphu-a4889049-8f96-4702-96cc-ddc8ac3e71cc","ackIdentity":{"mode":"verified","source":"claude-mcp-registry"},"pingDelivery":"replied"}` |
| same-harness reply (codex→codex) | ✅ pass | `{"trigger":"m-mulalrid-e2a2a7b4-8dec-4c35-aa5e-c724786cb7a3","ping":"m-mulalu5e-2bab9486-e5a7-4836-a389-34943152907d","pingIdentity":{"mode":"verified","source":"codex-mcp-meta"},"ack":"m-mulalwc1-4ef131c9-1d70-4301-b0d8-b6545289328f","ackIdentity":{"mode":"verified","source":"codex-mcp-meta"},"pingDelivery":"replied"}` |
| cross-harness reply (claude→codex) | ✅ pass | `{"trigger":"m-mulam0xr-636661d1-12e9-4dbb-b479-7bf7e2e92096","ping":"m-mulam2rs-8e3cb817-d31a-47d8-894f-92490c72bf8f","pingIdentity":{"mode":"verified","source":"claude-mcp-registry"},"ack":"m-mulam4lt-591a2a88-d3b3-499c-a7e0-4abf2cfadaca","ackIdentity":{"mode":"verified","source":"codex-mcp-meta"},"pingDelivery":"replied"}` |
| cross-harness reply (codex→claude) | ✅ pass | `{"trigger":"m-mulam6ua-03bf0016-6f61-453a-8c5a-6718195e4e97","ping":"m-mulam86t-0331697c-432f-427b-b3c9-25bc5cb906f4","pingIdentity":{"mode":"verified","source":"codex-mcp-meta"},"ack":"m-mulamb63-364c07cb-7beb-4a25-9f02-1bd6604ed3b6","ackIdentity":{"mode":"verified","source":"claude-mcp-registry"},"pingDelivery":"replied"}` |
| busy claude instance: back-to-back messages both answered, in order | ✅ pass | `{"first":"m-mulamcqp-f2196339-f0f6-455a-8f16-33a52eb58940","second":"m-mulamcqs-6deed7b4-2892-4dbd-b942-37a95521ffd3","submitted":["2026-09-28T13:38:29.522Z","2026-09-28T13:38:29.844Z"],"replied":["2026-09-28T13:38:32.411Z","2026-09-28T13:38:36.953Z"],"states":["replied","replied"],"coverage":"claude fixture only"}` |
| busy codex instance: back-to-back messages both answered, in order | ✅ pass | `{"first":"m-mulamiyp-d11b2d4c-c225-4fc3-af67-710c4173a7e7","second":"m-mulamiyz-f1b21e4a-5f22-4b8a-8ef7-41e293585f71","submitted":["2026-09-28T13:38:37.185Z","2026-09-28T13:38:37.295Z"],"replied":["2026-09-28T13:38:39.547Z","2026-09-28T13:38:43.087Z"],"states":["replied","replied"],"coverage":"codex fixture only"}` |
| offline instance does not block others | ✅ pass | `{"messageId":"m-mulamr4y-ca07768c-d616-4ba6-b776-fa5865a1ed33","offline":"fxb","offlineDelivery":{"state":"queued","waiting":"offline","attempts":[]},"repliedBy":["fxc","fxd","fxa"]}` |

## Errors

- none
