import type {Delivery} from '../contracts/domain.js';

/** Shared delivery evidence and recovery guidance for CLI and MCP clients. */
export function deliveryDetail(d:Delivery):string {
 const status=d.waiting?`waiting: ${d.waiting.replaceAll('_',' ')}`:d.held?'held (room paused)':d.state==='withdrawn'&&d.withdrawalCause==='kick'?'withdrawn (kicked)':d.state;
 let text=`${status}${d.referenced?' (full text available with roundtable read)':''}`;
 if(d.state==='failed'||d.state==='uncertain'||d.waiting){
  const error=d.attempts?.at(-1)?.error;
  if(error)text+=`\n  ${error.code}: ${error.message}`;
  const fallback=d.waiting==='rebind_needed'?'Verify the original binding with roundtable who. Rejoin for future messages; old deliveries are never redirected automatically.':d.waiting==='offline'?'Resume the original session; its queued work waits while other participants continue.':'Run roundtable doctor and inspect roundtable read <id> --json; ask the human to retry after correcting the issue.';
  text+=`\n  ${error?.hint??fallback}`;
  if(d.state==='uncertain')text+='\n  This may already have been delivered. Reconcile with the recipient before requesting a human retry.';
 }
 return text;
}
