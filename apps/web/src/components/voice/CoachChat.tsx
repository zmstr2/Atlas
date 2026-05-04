'use client';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useMemo, useRef, useState, useEffect } from 'react';
import { Streamdown } from 'streamdown';
import { LeadResultCard, CompanyResultCard, ContactResultCard, ToolErrorCard } from './CRMCard';
import type { CoachSuggestion } from '@/lib/coach/ws';
import { cn } from '@/lib/cn';

const AGENT_URL = process.env.NEXT_PUBLIC_AGENT_URL ?? 'http://localhost:3001';

export function CoachChat({
  callId,
  suggestions,
  title,
}: {
  callId: string;
  suggestions: CoachSuggestion[];
  title?: string;
}) {
  const transport = useMemo(() =>
    new DefaultChatTransport<UIMessage>({
      api: `${AGENT_URL}/chat`,
      headers: { 'X-Call-Id': callId },
    }), [callId]);

  const { messages, sendMessage, status } = useChat<UIMessage>({ transport });

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageTsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, suggestions]);

  const items: Array<
    | { kind: 'suggestion'; suggestion: CoachSuggestion; ts: number }
    | { kind: 'message'; message: UIMessage; ts: number }
  > = [];
  for (const s of suggestions) {
    items.push({ kind: 'suggestion', suggestion: s, ts: s.ts });
  }
  for (const m of messages) {
    let ts = messageTsRef.current.get(m.id);
    if (ts === undefined) {
      ts = Date.now();
      messageTsRef.current.set(m.id, ts);
    }
    items.push({ kind: 'message', message: m, ts });
  }
  items.sort((a, b) => a.ts - b.ts);

  return (
    <div className="relative flex flex-col h-full overflow-hidden">
      {/* Conversation title */}
      <div className="px-6 py-4 shrink-0">
        <div className="text-sm font-semibold text-fg-primary">
          {title ?? 'Atlas'}
        </div>
      </div>

      {/* Message list — pb-28 clears the floating composer height */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-10 pt-8 pb-28 space-y-6"
      >
        {items.length === 0 && (
          <div className="text-fg-muted text-sm pt-12 text-center">
            Connecting to Atlas…
          </div>
        )}
        {items.map(item =>
          item.kind === 'suggestion' ? (
            <SuggestionMessage key={`s-${item.suggestion.id}`} suggestion={item.suggestion} />
          ) : (
            <MessageRow key={item.message.id} message={item.message} />
          )
        )}
        {status === 'streaming' && (
          <div className="flex items-center gap-2 text-fg-muted text-sm">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-atlas-pulse" />
            Atlas is thinking…
          </div>
        )}
      </div>

      {/* Fade gradient — sits over the bottom of the scroll area, behind the composer */}
      <div
        className="absolute left-0 right-0 h-16 bg-gradient-to-t from-[#FAFAF9] to-transparent pointer-events-none z-10"
        style={{ bottom: 48 }}
      />

      {/* Composer — no padding: outer p-3 + sidebar ml-3 own all four gaps uniformly */}
      <div className="absolute bottom-0 left-0 right-0 z-20">
        <form
          className="flex gap-2 rounded-2xl border border-[#E7E5E4] bg-white shadow-sm px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            const text = input.trim();
            if (!text) return;
            void sendMessage({ text });
            setInput('');
          }}
        >
          <input
            className="flex-1 bg-transparent text-sm text-fg-primary placeholder:text-fg-muted focus:outline-none"
            placeholder="Ask Atlas about this call…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button
            type="submit"
            disabled={status === 'streaming' || !input.trim()}
            className="shrink-0 px-4 py-1.5 rounded-xl bg-accent text-white text-sm font-medium disabled:opacity-40 hover:bg-accent-hover transition"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

// Atlas-originated suggestion — markdown rendered, no bubble, label above
function SuggestionMessage({ suggestion }: { suggestion: CoachSuggestion }) {
  return (
    <div className="mr-12 animate-slide-in space-y-1">
      <div className="text-[11px] font-semibold text-fg-muted tracking-wide">Atlas</div>
      <div className="text-sm text-fg-primary leading-relaxed">
        <Streamdown>{suggestion.content}</Streamdown>
      </div>
    </div>
  );
}

// Chat message — user gets a plain-text bubble, Atlas gets markdown
function MessageRow({ message }: { message: UIMessage }) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end animate-slide-in">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm px-4 py-2.5 bg-[#F5F5F4] border border-[#E7E5E4] text-sm text-fg-primary">
          {message.parts.map((part, i) => renderPart(part, i, 'user'))}
        </div>
      </div>
    );
  }

  return (
    <div className="mr-12 animate-slide-in space-y-1">
      <div className="text-[11px] font-semibold text-fg-muted tracking-wide">Atlas</div>
      <div className="text-sm text-fg-primary leading-relaxed">
        {message.parts.map((part, i) => renderPart(part, i, 'assistant'))}
      </div>
    </div>
  );
}

function renderPart(part: UIMessage['parts'][number], key: number, role: 'user' | 'assistant'): React.ReactNode {
  switch (part.type) {
    case 'text':
      if (role === 'assistant') {
        return <Streamdown key={key}>{part.text}</Streamdown>;
      }
      return <div key={key} className="whitespace-pre-wrap">{part.text}</div>;
    case 'step-start':
      return key > 0 ? <hr key={key} className="my-2 border-border opacity-40" /> : null;
    case 'tool-lookupLead':
      return renderLookupLead(part, key);
    case 'tool-lookupCompany':
      return renderLookupCompany(part, key);
    case 'tool-findContact':
      return renderFindContact(part, key);
    default:
      if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
        return (
          <details key={key} className="text-xs">
            <summary className="text-fg-muted cursor-pointer">{part.type}</summary>
            <pre className="text-[10px] overflow-x-auto">{JSON.stringify(part, null, 2)}</pre>
          </details>
        );
      }
      return null;
  }
}

type ToolPart = Extract<UIMessage['parts'][number], { type: `tool-${string}` }> & {
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

function renderLookupLead(part: ToolPart, key: number) {
  if (part.state !== 'output-available') return <ToolPending key={key} label="Looking up lead" />;
  const out = part.output as { error?: string; [k: string]: unknown };
  if (out?.error) return <ToolErrorCard key={key} error={out.error} detail={out} />;
  return <LeadResultCard key={key} lead={out as never} />;
}

function renderLookupCompany(part: ToolPart, key: number) {
  if (part.state !== 'output-available') return <ToolPending key={key} label="Looking up company" />;
  const out = part.output as { error?: string; [k: string]: unknown };
  if (out?.error) return <ToolErrorCard key={key} error={out.error} detail={out} />;
  return <CompanyResultCard key={key} company={out as never} />;
}

function renderFindContact(part: ToolPart, key: number) {
  if (part.state !== 'output-available') return <ToolPending key={key} label="Finding contact" />;
  const out = part.output as { error?: string; [k: string]: unknown };
  if (out?.error) return <ToolErrorCard key={key} error={out.error} detail={out} />;
  return <ContactResultCard key={key} contact={out as never} />;
}

function ToolPending({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-fg-muted my-1">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-atlas-pulse" />
      {label}…
    </div>
  );
}
