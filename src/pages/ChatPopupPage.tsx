import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { supabase } from '../lib/supabase';

type ChatMessage = {
  id: string;
  sender_id: string;
  recipient_id: string;
  body: string;
  created_at: string;
};

type ChatTargetPayload = {
  id: string;
  personName?: string;
  lastName?: string;
  cityNameRu?: string;
  selectedCity?: string;
  gender?: string | null;
  mainPhoto?: string | null;
};

const CHAT_TABLE = 'user_messages';

function decodeBase64Unicode(value: string): string {
  try {
    if (typeof window !== 'undefined' && typeof window.atob === 'function') {
      const binary = window.atob(value);
      let result = '';
      for (let i = 0; i < binary.length; i += 1) {
        result += `%${binary.charCodeAt(i).toString(16).padStart(2, '0')}`;
      }
      return decodeURIComponent(result);
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(value, 'base64').toString('utf-8');
    }
  } catch (error) {
    console.warn('Не удалось декодировать данные окна чата', error);
  }
  return '';
}

function decodeTargetPayload(search: string): ChatTargetPayload | null {
  try {
    const params = new URLSearchParams(search);
    const raw = params.get('data');
    if (!raw) return null;
    const decoded = decodeBase64Unicode(decodeURIComponent(raw));
    if (!decoded) return null;
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') {
      return {
        id: parsed.id,
        personName: typeof parsed.personName === 'string' ? parsed.personName : '',
        lastName: typeof parsed.lastName === 'string' ? parsed.lastName : '',
        cityNameRu: typeof parsed.cityNameRu === 'string' ? parsed.cityNameRu : '',
        selectedCity: typeof parsed.selectedCity === 'string' ? parsed.selectedCity : '',
        gender: typeof parsed.gender === 'string' ? parsed.gender : null,
        mainPhoto: typeof parsed.mainPhoto === 'string' ? parsed.mainPhoto : null,
      };
    }
  } catch (error) {
    console.warn('Некорректные данные для окна чата', error);
  }
  return null;
}

const ChatPopupPage: React.FC = () => {
  const location = useLocation();
  const [target, setTarget] = useState<ChatTargetPayload | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    setTarget(decodeTargetPayload(location.search));
  }, [location.search]);

  useEffect(() => {
    let subscription: { unsubscribe: () => void } | undefined;
    supabase.auth
      .getSession()
      .then(({ data }) => setCurrentUserId(data.session?.user?.id ?? null))
      .catch(() => setCurrentUserId(null));
    try {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        setCurrentUserId(session?.user?.id ?? null);
      });
      subscription = data?.subscription;
    } catch {}
    return () => {
      try {
        subscription?.unsubscribe();
      } catch {}
    };
  }, []);

  const fetchHistory = useCallback(async () => {
    if (!target?.id || !currentUserId) return;
    setHistoryLoading(true);
    setError(null);
    try {
      const filter = `and(sender_id.eq.${currentUserId},recipient_id.eq.${target.id}),and(sender_id.eq.${target.id},recipient_id.eq.${currentUserId})`;
      const { data, error: queryError } = await supabase
        .from(CHAT_TABLE)
        .select('id,sender_id,recipient_id,body,created_at')
        .or(filter)
        .order('created_at', { ascending: true });
      if (queryError) throw queryError;
      setMessages((data ?? []) as ChatMessage[]);
    } catch (err) {
      console.error('Не удалось загрузить историю сообщений', err);
      setError('Не удалось загрузить историю сообщений.');
      setMessages([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [currentUserId, target?.id]);

  useEffect(() => {
    if (!target || !currentUserId) return;
    void fetchHistory();
  }, [target, currentUserId, fetchHistory]);

  useEffect(() => {
    if (!target || !currentUserId) return;
    const channel = supabase
      .channel(`chat-popup-${currentUserId}-${target.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: CHAT_TABLE }, (payload) => {
        const message = payload.new as ChatMessage | null;
        if (!message) return;
        const isMine = message.sender_id === currentUserId && message.recipient_id === target.id;
        const isTheirs = message.sender_id === target.id && message.recipient_id === currentUserId;
        if (isMine || isTheirs) {
          setMessages((prev) => [...prev, message]);
        }
      });
    channel.subscribe();
    return () => {
      try {
        supabase.removeChannel(channel);
      } catch {}
    };
  }, [target, currentUserId]);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const handleSend = useCallback(async () => {
    if (!target?.id || !currentUserId) {
      setError('Нужно войти в профиль, чтобы отправлять сообщения.');
      return;
    }
    const text = input.trim();
    if (!text) return;
    setSending(true);
    setError(null);
    try {
      const { error: insertError } = await supabase
        .from(CHAT_TABLE)
        .insert({
          sender_id: currentUserId,
          recipient_id: target.id,
          body: text,
        });
      if (insertError) throw insertError;
      setInput('');
    } catch (err) {
      console.error('Не удалось отправить сообщение', err);
      setError('Не удалось отправить сообщение.');
    } finally {
      setSending(false);
    }
  }, [input, target, currentUserId]);

  const allowMessaging = Boolean(target && currentUserId);
  const cityLabel = useMemo(() => {
    if (!target) return '—';
    return target.cityNameRu || target.selectedCity || '—';
  }, [target]);

  if (!target) {
    return (
      <div className="h-screen bg-slate-950 text-white flex items-center justify-center p-6 text-center text-sm overflow-hidden">
        Не удалось открыть окно чата. Закройте это окно и попробуйте снова из приложения.
      </div>
    );
  }

  return (
    <div className="h-screen bg-slate-950 text-white flex flex-col overflow-hidden">
      <header className="px-4 py-3 border-b border-white/10">
        <div className="text-xs tracking-wide text-white/70">Чат с</div>
        <div className="text-lg font-semibold">
          {[target.personName, target.lastName].filter(Boolean).join(' ') || 'Пользователем'}
        </div>
        <div className="text-xs text-white/60 mt-1">{cityLabel}</div>
      </header>
      <div className="flex-1 px-4 py-3 flex flex-col gap-3 overflow-hidden">
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-y-auto rounded-2xl bg-white/5 border border-white/10 p-3 space-y-2"
        >
          {historyLoading ? (
            <div className="text-sm text-white/70">Загрузка переписки...</div>
          ) : messages.length === 0 ? (
            <div className="text-sm text-white/60">Нет сообщений. Напишите первым.</div>
          ) : (
            messages.map((message) => {
              const mine = message.sender_id === currentUserId;
              return (
                <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-snug whitespace-pre-wrap break-words ${
                      mine ? 'bg-blue-600 text-white' : 'bg-white/10 text-white'
                    }`}
                  >
                    <div>{message.body}</div>
                    <div className="text-[10px] text-white/70 mt-1 text-right">
                      {new Date(message.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
        {error ? <div className="text-xs text-red-400">{error}</div> : null}
        <div className="pb-4 shrink-0" style={{ marginBottom: "20px" }}>
          <div className="flex gap-3 items-end">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={allowMessaging ? "Введите сообщение..." : "Войдите в профиль, чтобы писать сообщения"}
              className="flex-1 min-h-[80px] max-h-40 rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50 resize-none"
              disabled={!allowMessaging || sending}
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={!allowMessaging || !input.trim() || sending}
              className="h-10 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {sending ? "Отправка…" : "Отправить"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatPopupPage;
