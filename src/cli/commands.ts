import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { RoomClient } from '../ipc/client.js';
import { resolveRoomRoot } from '../core/registry/root.js';
import { readRegistry, migrateLegacyRegistry } from '../core/registry/registry.js';
import { loadConfig } from '../core/config.js';
import { defaultRegistryDeps, resolveClaudeConfigDir } from '../adapters/claude/registry.js';
import { resolveCodexExecutable } from '../adapters/codex/adapter.js';
import { windowsProcessInfo } from '../mcp/identity.js';
import { cliCaller } from './identity.js';
import { RoomError, toErrorInfo } from '../contracts/errors.js';
import { MAX_FRAME_BYTES, type Caller } from '../contracts/ipc.js';
import { sanitize } from '../tui/format.js';
import {formatResult} from './format.js';
import {guardedSendText, inboxPageText, withdrawText} from '../presentation/crossing.js';

export const COMMANDS = ['send','reply','read','inbox','withdraw','who','join','doctor','pause','resume','retry','shutdown','migrate'];
export const COMMAND_HELP = `room send [--as NAME] [--to NAME,NAME|all|human] [--reply-to ID|#N]
          [--snapshot TOKEN] [--urgent --reason TEXT] [--revises ATTEMPT]
          [--client-message-id KEY] [--file PATH | --stdin | TEXT...]
room reply ID|#N [--as NAME] [--snapshot TOKEN] [--urgent --reason TEXT] [--revises ATTEMPT]
          [--file PATH | --stdin | TEXT...]
room read [ID|#N] [--after N] [--limit N]
room inbox [--as NAME] [--snapshot TOKEN] [--cursor CURSOR] [--limit N] | --baseline REASON
room withdraw ID|#N [--as NAME] [--recipients NAME,NAME]
room who
room join --as NAME [--rebind]
room doctor
room pause [--resend-stop] | resume | shutdown
room retry ID|#N RECIPIENT [--confirm-uncertain]
room migrate

All commands accept --json. Exit: 0 success, 2 input/identity error, 3 unavailable/uncertain service,
4 agent send not sent by the crossing guard (nothing queued; the output shows what to read first),
or a withdraw that cancelled nothing.
Agent sends need --snapshot from room inbox or the delivery being answered. --urgent (with --reason)
skips that check and goes ahead of queued ordinary messages; it is audited. The human is never guarded.
withdraw cancels only deliveries not yet handed to a recipient's session; after that it is too late.
Ordinary human sends broadcast; agents must choose --to. --as fallback is labelled declared.
Use --file or --stdin to avoid shell quoting. -- ends option parsing.
Pause holds future delivery and sends a stop request; it cannot interrupt a busy turn.
Retry, pause, resume, shutdown and legacy registry migration are human-only.
Reusing --client-message-id safely reconciles a lost send response. No automatic resend.
reply and send --reply-to default to the original sender when --to is omitted.`;

type Link = Pick<RoomClient, 'request' | 'close'>;
export interface CommandDeps {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  out?: (text: string) => void;
  err?: (text: string) => void;
  stdin?: () => Promise<string>;
  identify?: (name: string | null) => Promise<Caller>;
  connect?: (root: string, autoStart: boolean) => Promise<Link>;
}
const flags: Record<string, string[]> = {
  send:['as','to','reply-to','client-message-id','file','stdin','snapshot','urgent','reason','revises'],
  reply:['as','to','client-message-id','file','stdin','snapshot','urgent','reason','revises'],
  read:['after','limit'], inbox:['as','snapshot','cursor','limit','baseline'], withdraw:['as','recipients'], who:[],
  join:['as','rebind'], doctor:[], pause:['resend-stop'], resume:[], retry:['confirm-uncertain'], shutdown:[], migrate:[],
};
const booleans = new Set(['json','stdin','rebind','resend-stop','confirm-uncertain','urgent']);
function parse(argv: string[], command: string) {
  const options: Record<string,string|true> = {}; const positional: string[] = []; let ended = false;
  for (let i=0;i<argv.length;i++) {
    const arg=argv[i]!;
    if (!ended && arg==='--') { ended=true; continue; }
    if (!ended && arg.startsWith('--')) {
      const key=arg.slice(2);
      if (key!=='json'&&!flags[command]?.includes(key)) throw new RoomError('bad_request', `Unknown option ${arg}.`);
      if (key in options) throw new RoomError('bad_request', `Repeated option ${arg}.`);
      if (booleans.has(key)) options[key]=true;
      else { const value=argv[++i]; if(value===undefined||value.startsWith('--')) throw new RoomError('bad_request', `Missing value for ${arg}.`); options[key]=value; }
    } else positional.push(arg);
  }
  return { options, positional };
}
function integer(value: string | true | undefined, label: string): number | undefined {
  if(value===undefined)return undefined;
  if(typeof value!=='string'||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))throw new RoomError('bad_request', `${label} must be a nonnegative integer.`);
  return Number(value);
}
async function ref(link: Link, value: string): Promise<string> {
  if(!/^#?\d+$/.test(value))return value;
  const seq=Number(value.replace(/^#/,''));
  if(!Number.isSafeInteger(seq)||seq<1)throw new RoomError('bad_request','Message numbers start at 1.');
  const result=await link.request('read',{afterSeq:seq-1,limit:1});
  const item=result.items.find(x=>x.message.seq===seq);
  if(!item)throw new RoomError('not_found',`No message #${seq}.`);
  return item.message.id;
}
async function readStdin(): Promise<string> {
  if(process.stdin.isTTY)throw new RoomError('bad_request','Pipe text into --stdin or pass --file.');
  process.stdin.setEncoding('utf8');
  let value=''; for await(const chunk of process.stdin){value+=chunk.toString();if(Buffer.byteLength(value)>MAX_FRAME_BYTES/2)throw new RoomError('message_too_large','Input exceeds the room message budget.');} return value;
}

export async function runCommand(command: string, argv: string[], deps: CommandDeps = {}): Promise<number> {
  const out=deps.out??console.log, err=deps.err??console.error;
  if(argv.length===1&&(argv[0]==='--help'||argv[0]==='-h')){out(COMMAND_HELP);return 0;}
  let link: Link | undefined; let json=false;
  try {
    const {options:o,positional:p}=parse(argv,command); json=!!o.json;
    const text=(key:string)=>typeof o[key]==='string'?o[key] as string:undefined;
    if(command!=='send'&&command!=='reply'&&p.length>(command==='retry'?2:command==='read'||command==='withdraw'?1:0))throw new RoomError('bad_request','Unexpected positional arguments.');
    const cwd=deps.cwd??process.cwd(), config=loadConfig(deps.env??process.env);
    const root=await resolveRoomRoot(cwd,config.roomRoot??undefined);
    const identify=deps.identify??(name=>cliCaller(name,{
      env:deps.env??process.env,ownParentPid:process.ppid,processInfo:windowsProcessInfo(config.claudeProcStartTimeoutMs),
      claudeRegistry:defaultRegistryDeps(resolveClaudeConfigDir(config.claudeConfigDir,deps.env??process.env),config.claudeProcStartTimeoutMs),
    },message=>err(sanitize(message))));
    const connect=deps.connect??((root,autoStart)=>RoomClient.connect(root,{client:'cli',autoStart}));
    const print=(value:unknown)=>out(json?JSON.stringify(value):formatResult(command,value));
    if(command==='migrate') {
      if((await identify(null)).kind!=='human')throw new RoomError('identity_mismatch','Only the human may migrate the registry.');
      print({registry:await migrateLegacyRegistry(root)});return 0;
    }
    if(command==='doctor') {
      const checks:Record<string,unknown>={root,registry:null,codexExecutable:resolveCodexExecutable(config.codexExecutable,root,deps.env??process.env),service:null};
      let healthy=true;
      try{
        const registry=await readRegistry(root);checks.registry=registry;
        if(Object.values(registry).some(p=>p.harness==='codex')&&!checks.codexExecutable){
          healthy=false;checks.codexError={code:'service_unavailable',message:'Registered Codex participants cannot receive messages: native executable missing.',hint:'Install Codex on PATH or set ROOM_CODEX_EXECUTABLE to the native codex.exe (not a shell wrapper).'};
        }
      }catch(e){const info=toErrorInfo(e);checks.registry={...info,hint:info.code==='invalid_state'?'From a human terminal, run room migrate for the known legacy schema; preserve and repair unknown schemas manually.':info.hint};healthy=false;}
      try{link=await connect(root,false);checks.service=await link.request('who',{});}catch(e){checks.service={...toErrorInfo(e),hint:'Run room who or room tui to auto-start the service. If that fails, inspect .room/service.lock and the reported configuration error; do not delete a live owner lock.'};healthy=false;}
      print(checks);return healthy?0:3;
    }
    link=await connect(root,true);
    if(command==='read'){print(await link.request('read',{...(p[0]?{messageId:await ref(link,p[0])}:{}),afterSeq:integer(o.after,'after'),limit:integer(o.limit,'limit'),includeDeliveries:true}));return 0;}
    if(command==='who'){print(await link.request('who',{}));return 0;}
    const caller=await identify(text('as')??null);
    if(command==='send'||command==='reply') {
      const replyRef=command==='reply'?p.shift():text('reply-to');
      if(command==='reply'&&!replyRef)throw new RoomError('bad_request','reply requires a message ID or #number.');
      const sourceCount=Number(!!o.file)+Number(!!o.stdin)+Number(p.length>0);
      if(sourceCount!==1)throw new RoomError('bad_request','Provide exactly one message source: text, --file or --stdin.');
      const body=o.file?await readFile(text('file')!,'utf8'):o.stdin?await(deps.stdin??readStdin)():p.join(' ');
      const replyTo=replyRef?await ref(link,replyRef):null;
      let to=text('to')?.split(/[,\s]+/).map(x=>x.replace(/^@/,'').toLowerCase()).filter(Boolean)??null;
      if(to===null&&replyTo){const original=(await link.request('read',{messageId:replyTo})).items[0];if(!original)throw new RoomError('not_found','The message being replied to no longer exists.');to=[original.message.from.name];}
      const reason=text('reason')?.trim()??'';
      const guardFlags=o.snapshot!==undefined||!!o.urgent||o.reason!==undefined||o.revises!==undefined;
      if(caller.kind==='human'&&guardFlags)throw new RoomError('bad_request','--snapshot, --urgent, --reason and --revises are for agent sends; the human is never guarded.');
      if(caller.kind==='agent'&&o.urgent&&!reason)throw new RoomError('bad_request','An urgent send needs --reason.','Say why it cannot wait, or drop --urgent and send with --snapshot.');
      if(caller.kind==='agent'&&!o.urgent&&o.reason!==undefined)throw new RoomError('bad_request','--reason is only used with --urgent.');
      if(reason.length>config.urgentReasonMaxChars)throw new RoomError('bad_request',`An urgent reason can be at most ${config.urgentReasonMaxChars} characters.`,'Keep the reason short; put the details in the message.');
      const clientMessageId=text('client-message-id')??randomUUID();
      // Printed before dispatch so a lost response still leaves a usable idempotency key.
      err(sanitize(`client_message_id=${clientMessageId}`));
      if(caller.kind==='human'){print(await link.request('send',{caller,to,body,replyTo,clientMessageId}));return 0;}
      const outcome=await link.request('guarded_send',{caller,to,body,replyTo,clientMessageId,
        ...(text('snapshot')!==undefined?{snapshot:text('snapshot')!}:{}),...(o.urgent?{urgent:{reason}}:{}),...(text('revises')!==undefined?{revisesAttemptId:text('revises')!}:{})});
      if(json)out(JSON.stringify(outcome));
      else if(outcome.status==='not_sent')out(sanitize(guardedSendText(outcome,'cli')));
      else{const extra=guardedSendText(outcome,'cli');out(formatResult('send',outcome.result)+(extra?'\n'+sanitize(extra):''));}
      // 4: refused by the crossing guard with nothing queued, distinct from input (2) and service (3) errors.
      return outcome.status==='sent'?0:4;
    }
    if(command==='inbox'){
      if(caller.kind!=='agent')throw new RoomError('identity_mismatch','inbox reviews an agent\'s messages; no agent context was detected.','Run it from the agent\'s session, or pass --as NAME.');
      const baseline=text('baseline')?.trim();
      if(o.baseline!==undefined&&!baseline)throw new RoomError('bad_request','--baseline needs a reason.');
      if(baseline&&(o.snapshot!==undefined||o.cursor!==undefined))throw new RoomError('bad_request','--baseline cannot be combined with --snapshot or --cursor.');
      const page=await link.request('inbox',{caller,...(baseline?{baseline:{reason:baseline}}:{}),...(text('snapshot')!==undefined?{snapshot:text('snapshot')!}:{}),...(text('cursor')!==undefined?{cursor:text('cursor')!}:{}),...(o.limit!==undefined?{limit:integer(o.limit,'limit')!}:{})});
      out(json?JSON.stringify(page):sanitize(inboxPageText(page,'cli')));return 0;
    }
    if(command==='withdraw'){
      if(p.length!==1)throw new RoomError('bad_request','withdraw requires a message ID or #number.');
      const messageId=await ref(link,p[0]!);const seq=/^#?(\d+)$/.exec(p[0]!);
      const recipients=text('recipients')?.split(/[,\s]+/).map(x=>x.replace(/^@/,'').toLowerCase()).filter(Boolean);
      if(recipients&&recipients.length===0)throw new RoomError('bad_request','--recipients names nobody.');
      // "all" (like omitting it) means every ORIGINAL recipient, which is the service default.
      const outcome=await link.request('withdraw',{caller,messageId,...(recipients&&!recipients.includes('all')?{recipients}:{})});
      out(json?JSON.stringify(outcome):sanitize(withdrawText(outcome,seq?Number(seq[1]):undefined)));
      // 4 when this call cancelled nothing (too late, in flight, or already withdrawn), as with a refused send.
      return outcome.recipients.some(r=>r.disposition==='withdrawn')?0:4;
    }
    if(command==='join') {
      const name=text('as');if(!name)throw new RoomError('bad_request','join requires --as NAME.');
      if(caller.kind!=='agent'||!caller.native)throw new RoomError('identity_unresolved','Joining requires detected native identity. Follow the documented manual session.toml fallback if detection is unavailable.');
      let expectedPrevious;
      if(o.rebind){const current=(await link.request('who',{})).participants.find(x=>x.name===name);
        if(current&&current.sessionId!==caller.native.sessionId){
          if(current.harness!==caller.native.harness||current.liveness==='online')throw new RoomError('rebind_conflict','Cannot take over a live or different-harness participant.');
          expectedPrevious={harness:current.harness,sessionId:current.sessionId};
        }
      }
      print(await link.request('join',{name,native:caller.native,expectedPrevious}));return 0;
    }
    if(caller.kind!=='human')throw new RoomError('identity_mismatch',`${command} is human-only; agent context detected.`);
    if(command==='retry'){
      if(p.length!==2)throw new RoomError('bad_request','retry requires a message ID and recipient.');
      const messageId=await ref(link,p[0]!);const recipient=p[1]!;
      const delivery=(await link.request('deliveries',{messageId})).deliveries.find(x=>x.recipient===recipient);
      if(delivery?.state==='uncertain'&&!o['confirm-uncertain'])throw new RoomError('invalid_state','This may duplicate delivery. Reconcile first, then repeat with --confirm-uncertain.');
      print(await link.request('retry',{caller,messageId,recipient}));return 0;
    }
    if(command==='pause'){print(await link.request('pause',{caller,resendStopRequest:!!o['resend-stop']}));return 0;}
    if(command==='resume'||command==='shutdown'){print(await link.request(command,{caller}));return 0;}
    throw new RoomError('bad_request',`Unknown command ${command}.`);
  } catch(e) {
    const info=toErrorInfo(e);err(json?JSON.stringify({error:info}):sanitize(`${info.code}: ${info.message}\n${info.hint??''}`));
    return ['service_unavailable','unsupported_version','internal'].includes(info.code)?3:2;
  } finally {link?.close();}
}
