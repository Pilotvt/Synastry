import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useProfile } from '../store/profile';
import { blockUser, unblockUser } from '../lib/blocklist';
import { useBlocklistStore } from '../store/blocklist';
import { moderateText } from '../services/moderation';

type ChatMessage = {
  id: string;
  sender_id: string;
  recipient_id: string;
  body: string;
  created_at: string;
  read_at?: string | null;
  moderation_reasons?: string[] | null;
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

type Gender = 'male' | 'female' | null;

const normalizeGender = (value: unknown): Gender => {
  return value === 'male' || value === 'female' ? value : null;
};

const MALE_BUBBLE = 'text-white shadow-[0px_6px_18px_rgba(15,23,42,0.35)]';
const FEMALE_BUBBLE = 'text-white shadow-[0px_6px_18px_rgba(236,72,153,0.35)]';
const NEUTRAL_THEIRS = 'text-white shadow-[0px_6px_18px_rgba(15,23,42,0.25)]';
const NEUTRAL_MINE = 'text-white shadow-[0px_6px_18px_rgba(15,23,42,0.35)]';

const LOCAL_PROFANITY_PATTERNS: RegExp[] = [
  /х[уy]й[а-яё]*/gi,
  /хуйн[яеё]/gi,
  /пизд[а-яё]*/gi,
  /п[иі]ськ[а-яё]*/gi,
  /еб[аоыёу][а-яё]*/gi,
  /сука/gi,
];

function applyLocalProfanityCensor(text: string): { censored: string; matches: string[] } {
  let censored = text;
  const matches: string[] = [];
  for (const pattern of LOCAL_PROFANITY_PATTERNS) {
    const found = Array.from(censored.matchAll(pattern)).map((m) => m[0]).filter(Boolean);
    if (found.length) {
      matches.push(...found);
      censored = censored.replace(pattern, '***');
    }
  }
  return { censored, matches };
}

function bubbleColorClass(isMine: boolean, gender: Gender): string {
  if (gender === 'male') return MALE_BUBBLE;
  if (gender === 'female') return FEMALE_BUBBLE;
  return isMine ? NEUTRAL_MINE : NEUTRAL_THEIRS;
}

const bubbleBackgroundStyle = (isMine: boolean, gender: Gender): React.CSSProperties => {
  if (gender === 'male') {
    return { background: 'linear-gradient(135deg, #38bdf8 0%, #1d4ed8 50%, #1e3a8a 100%)', border: '1px solid rgba(125, 211, 252, 0.35)' };
  }
  if (gender === 'female') {
    return { background: 'linear-gradient(135deg, #fb7185 0%, #ec4899 55%, #c026d3 100%)', border: '1px solid rgba(251, 113, 133, 0.4)' };
  }
  if (isMine) {
    return { background: 'linear-gradient(135deg, #e5aeffff 0%, #bf00ffff 100%)', border: '1px solid rgba(253, 248, 255, 0.15)' };
  }
  return { background: 'linear-gradient(135deg, rgba(248, 250, 252, 0.1) 0%, rgba(148, 163, 184, 0.55) 100%)', border: '1px solid rgba(248, 250, 252, 0.25)' };
};

const TAIL_MINE = 'rounded-[10px_10px_4px_10px]';
const TAIL_THEIRS = 'rounded-[10px_4px_10px_10px]';

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

type PendingMessage = {
  tempId: string;
  body: string;
  senderId: string;
  recipientId: string;
  createdAt: number;
};

const ChatPopupPage: React.FC = () => {
  const location = useLocation();
  const [target, setTarget] = useState<ChatTargetPayload | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const currentProfileGender = useProfile((state) => state.profile.gender ?? null);
  const [input, setInput] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocklistEntries = useBlocklistStore((state) => state.entries);
  const addBlockedEntry = useBlocklistStore((state) => state.addEntry);
  const removeBlockedEntry = useBlocklistStore((state) => state.removeEntry);
  const targetBlockedEntry = target?.id ? blocklistEntries[target.id] : undefined;
  const isTargetBlocked = Boolean(targetBlockedEntry);
  const [blockBusy, setBlockBusy] = useState(false);
  const [showBlockConfirm, setShowBlockConfirm] = useState(false);
  const [blockStatus, setBlockStatus] = useState<string | null>(null);
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
    setBlockStatus(null);
    setShowBlockConfirm(false);
    setBlockBusy(false);
  }, [target?.id]);

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
    } catch (error) {
      console.warn('Не удалось подписаться на изменения сессии', error);
    }
    return () => {
      try {
        subscription?.unsubscribe();
      } catch (error) {
        console.warn('Не удалось отписаться от обновлений сессии', error);
      }
    };
  }, []);

  const pendingMessagesRef = useRef<PendingMessage[]>([]);

  const registerPendingMessage = useCallback((entry: PendingMessage) => {
    pendingMessagesRef.current = [...pendingMessagesRef.current, entry];
  }, []);

  const removePendingMessage = useCallback((tempId: string) => {
    pendingMessagesRef.current = pendingMessagesRef.current.filter((item) => item.tempId !== tempId);
  }, []);

  const resolvePendingMessage = useCallback((incoming: ChatMessage): boolean => {
    const incomingTime = new Date(incoming.created_at).getTime();
    const resolvedIndex = pendingMessagesRef.current.findIndex((pending) => {
      if (pending.senderId !== incoming.sender_id || pending.recipientId !== incoming.recipient_id) return false;
      if (pending.body !== incoming.body) return false;
      if (!Number.isFinite(incomingTime)) return true;
      return Math.abs(incomingTime - pending.createdAt) < 30_000;
    });
    if (resolvedIndex === -1) {
      return false;
    }
    const pending = pendingMessagesRef.current[resolvedIndex];
    pendingMessagesRef.current.splice(resolvedIndex, 1);
    setMessages((prev) => prev.map((msg) => (msg.id === pending.tempId ? incoming : msg)));
    return true;
  }, []);

  const upsertMessage = useCallback((incoming: ChatMessage) => {
    setMessages((prev) => {
      const existingIndex = prev.findIndex((msg) => msg.id === incoming.id);
      if (existingIndex !== -1) {
        const copy = prev.slice();
        copy[existingIndex] = incoming;
        return copy;
      }
      return [...prev, incoming];
    });
  }, []);

  const fetchHistory = useCallback(async () => {
    if (!target?.id || !currentUserId) return;
    setHistoryLoading(true);
    setError(null);
    try {
      const filter = `and(sender_id.eq.${currentUserId},recipient_id.eq.${target.id}),and(sender_id.eq.${target.id},recipient_id.eq.${currentUserId})`;
      const { data, error: queryError } = await supabase
        .from(CHAT_TABLE)
        .select('id,sender_id,recipient_id,body,created_at,read_at,moderation_reasons')
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
          const resolved = resolvePendingMessage(message);
          if (!resolved) {
            upsertMessage(message);
          }
        }
      });
    channel.subscribe();
    return () => {
      try {
        supabase.removeChannel(channel);
      } catch (error) {
        console.warn('Не удалось удалить канал чата', error);
      }
    };
  }, [target, currentUserId, resolvePendingMessage, upsertMessage]);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const handleSend = useCallback(async () => {
    if (!target?.id || !currentUserId) {
      setError('Не удалось найти адресата, авторизуйтесь повторно.');
      return;
    }
    if (isTargetBlocked) {
      setError('Пользователь в блоклисте. Разблокируйте, чтобы написать.');
      return;
    }
    const text = input.trim();
    if (!text) return;
    setSending(true);
    setError(null);

    let moderatedBody = text;
    let moderationReasons: string[] | undefined;
    const collectedReasons: string[] = [];

    const localModeration = applyLocalProfanityCensor(text);
    if (localModeration.matches.length > 0) {
      moderatedBody = localModeration.censored;
      collectedReasons.push('Локальный фильтр');
    }

    try {
      const verdict = await moderateText(text, 'ru');
      if (verdict) {
        if (!verdict.isClean) {
          moderatedBody = verdict.censoredText;
          const apiReasons = verdict.reasons.length ? verdict.reasons : ['Обнаружена ненормативная лексика'];
          collectedReasons.push(...apiReasons);
        } else if (moderatedBody === text) {
          moderatedBody = verdict.censoredText;
        }
      }
    } catch (moderationError) {
      console.warn('Модерация текста недоступна, отправляем как есть', moderationError);
    }

    if (moderatedBody !== text) {
      moderationReasons = [`Сработал цензурный фильтр: ${moderatedBody}`];
    } else if (collectedReasons.length > 0) {
      moderationReasons = [`Сработал цензурный фильтр`];
    }

    const optimisticId = `optimistic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const optimisticMessage: ChatMessage = {
      id: optimisticId,
      sender_id: currentUserId,
      recipient_id: target.id,
      body: moderatedBody,
      created_at: new Date().toISOString(),
      moderation_reasons: moderationReasons ?? null,
    };
    setMessages((prev) => [...prev, optimisticMessage]);
    registerPendingMessage({
      tempId: optimisticId,
      body: moderatedBody,
      senderId: currentUserId,
      recipientId: target.id,
      createdAt: Date.now(),
    });
    try {
      const { data: inserted, error: insertError } = await supabase
        .from(CHAT_TABLE)
        .insert({
          sender_id: currentUserId,
          recipient_id: target.id,
          body: moderatedBody,
          moderation_reasons: moderationReasons ?? null,
        })
        .select('id,sender_id,recipient_id,body,created_at,moderation_reasons')
        .single();
      if (insertError) throw insertError;
      if (inserted) {
        const replaced = resolvePendingMessage(inserted as ChatMessage);
        if (!replaced) {
          upsertMessage(inserted as ChatMessage);
        }
      }
      setInput('');
    } catch (err) {
      removePendingMessage(optimisticId);
      setMessages((prev) => prev.filter((msg) => msg.id !== optimisticId));
      console.error('Не удалось отправить сообщение', err);
      setError('Не удалось отправить сообщение.');
    } finally {
      setSending(false);
    }
  }, [input, target, currentUserId, registerPendingMessage, resolvePendingMessage, upsertMessage, removePendingMessage, isTargetBlocked]);


  const cityLabel = useMemo(() => {
    if (!target) return '—';
    return target.cityNameRu || target.selectedCity || '—';
  }, [target]);

  const allowMessaging = Boolean(target && currentUserId && !isTargetBlocked);

  const unreadIncomingIds = useMemo(() => {
    if (!target?.id || !currentUserId) return [] as string[];
    return messages
      .filter((message) => message.sender_id === target.id && message.recipient_id === currentUserId && !message.read_at)
      .map((message) => message.id);
  }, [messages, target?.id, currentUserId]);

  const handleStartBlock = useCallback(() => {
    if (!target?.id) return;
    setBlockStatus(null);
    setShowBlockConfirm(true);
  }, [target?.id]);

  const handleBlockConfirm = useCallback(async () => {
    if (!target?.id || !currentUserId) {
      setError('Нужно войти в профиль, чтобы управлять чёрным списком.');
      return;
    }
    setBlockBusy(true);
    setBlockStatus(null);
    try {
      const summary = await blockUser(currentUserId, target.id, {
        id: target.id,
        personName: target.personName || '',
        lastName: target.lastName || '',
        cityName: cityLabel,
        mainPhoto: target.mainPhoto ?? null,
        blockedAt: new Date().toISOString(),
      });
      addBlockedEntry(summary);
      setBlockStatus('Пользователь добавлен в чёрный список.');
      setShowBlockConfirm(false);
    } catch (blockError) {
      console.error('Не удалось заблокировать пользователя', blockError);
      setBlockStatus('Не удалось заблокировать пользователя. Попробуйте позже.');
    } finally {
      setBlockBusy(false);
    }
  }, [currentUserId, target, cityLabel, addBlockedEntry]);

  const handleUnblock = useCallback(async () => {
    if (!target?.id || !currentUserId) {
      setError('Нужно войти в профиль, чтобы управлять чёрным списком.');
      return;
    }
    setBlockBusy(true);
    setBlockStatus(null);
    setShowBlockConfirm(false);
    try {
      await unblockUser(currentUserId, target.id);
      removeBlockedEntry(target.id);
      setBlockStatus('Пользователь разблокирован.');
    } catch (unblockError) {
      console.error('Не удалось разблокировать пользователя', unblockError);
      setBlockStatus('Не удалось разблокировать пользователя. Попробуйте позже.');
    } finally {
      setBlockBusy(false);
    }
  }, [currentUserId, target?.id, removeBlockedEntry]);

  const markConversationRead = useCallback(
    async (messageIds: string[]) => {
      if (!target?.id || !currentUserId || messageIds.length === 0) return;
      const nowIso = new Date().toISOString();
      const ids = new Set(messageIds);
      setMessages((prev) =>
        prev.map((msg) => (ids.has(msg.id) ? { ...msg, read_at: nowIso } : msg)),
      );
      try {
        await supabase
          .from(CHAT_TABLE)
          .update({ read_at: nowIso })
          .is('read_at', null)
          .eq('recipient_id', currentUserId)
          .eq('sender_id', target.id);
      } catch (markError) {
        console.warn('Не удалось пометить сообщения прочитанными', markError);
      }
    },
    [currentUserId, target?.id],
  );

  useEffect(() => {
    if (unreadIncomingIds.length === 0) return;
    void markConversationRead(unreadIncomingIds);
  }, [unreadIncomingIds, markConversationRead]);

  if (!target) {
    return (
      <div className="h-screen bg-slate-950 text-white flex items-center justify-center p-6 text-center text-sm overflow-hidden">
        Не удалось открыть окно чата. Закройте это окно и попробуйте снова из приложения.
      </div>
    );
  }

  return (
    <div className="h-screen bg-slate-950 text-white flex flex-col overflow-hidden relative">
      <header className="px-4 py-3 border-b border-white/10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs tracking-wide text-white/70">Чат с</div>
            <div className="text-lg font-semibold">
              {[target.personName, target.lastName].filter(Boolean).join(' ') || 'Пользователем'}
            </div>
            <div className="text-xs text-white/60 mt-1">{cityLabel}</div>
          </div>
          <div className="shrink-0 flex flex-col items-end gap-2">
            <button
              type="button"
              onClick={isTargetBlocked ? handleUnblock : handleStartBlock}
              disabled={blockBusy}
              className={`text-xs px-3 py-1.5 rounded-lg border text-white/80 hover:bg-white/10 disabled:opacity-50 ${
                isTargetBlocked ? 'border-emerald-400 text-emerald-200' : 'border-red-400 text-red-200'
              }`}
            >
              {isTargetBlocked ? 'Разблокировать' : 'Заблокировать'}
            </button>
          </div>
        </div>
        {blockStatus ? (
          <div className={`text-xs mt-2 ${blockStatus.startsWith('Не удалось') ? 'text-red-300' : 'text-emerald-300'}`}>
            {blockStatus}
          </div>
        ) : null}
      </header>
      {isTargetBlocked ? (
        <div className="px-4 py-2 text-xs text-amber-200 bg-amber-500/10 border-b border-amber-400/20">
          Пользователь находится в чёрном списке. Сообщения скрыты до разблокировки.
        </div>
      ) : null}
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
              const senderGender: Gender = mine
                ? normalizeGender(currentProfileGender)
                : normalizeGender(target.gender);
              const bubbleClass = bubbleColorClass(mine, senderGender);
              const tailClass = mine ? TAIL_MINE : TAIL_THEIRS;
              const bubbleStyle = bubbleBackgroundStyle(mine, senderGender);
              const rowSpacingClass = mine ? 'justify-end pr-12 pl-4' : 'justify-start pl-12 pr-4';
              return (
                <div key={message.id} className={`flex ${rowSpacingClass}`}>
                  <div
                    className={`max-w-[90%] px-5 py-3 text-sm leading-snug whitespace-pre-wrap break-words overflow-hidden border border-transparent ${bubbleClass} ${tailClass}`}
                    style={bubbleStyle}
                  >
                    <div className="break-words whitespace-pre-wrap text-sm leading-relaxed text-white/95" style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                      {message.body}
                    </div>
                    {Array.isArray(message.moderation_reasons) && message.moderation_reasons.length > 0 ? (
                      <div className="text-[11px] text-amber-100 mt-1 opacity-80">
                        {message.moderation_reasons.join('; ')}
                      </div>
                    ) : null}
                    <div className="text-[10px] text-white/80 mt-1 text-right">
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
        {showBlockConfirm ? (
          <div className="absolute inset-0 bg-black/70 flex items-center justify-center px-4 z-50">
            <div className="bg-slate-900 rounded-2xl border border-white/10 p-5 max-w-sm w-full shadow-2xl">
              <div className="text-lg font-semibold mb-2">Заблокировать пользователя?</div>
              <p className="text-sm text-white/80 mb-4 leading-relaxed">
                {`Мы уберём ${[target.personName, target.lastName].filter(Boolean).join(' ') || 'этого пользователя'} из списка анкет и чатовых уведомлений. Сообщения и звонки будут скрыты.`}
              </p>
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  className="px-4 py-2 text-sm rounded-lg border border-white/30 text-white/80 hover:bg-white/10 disabled:opacity-50"
                  onClick={() => setShowBlockConfirm(false)}
                  disabled={blockBusy}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="px-4 py-2 text-sm rounded-lg bg-red-600 text-white font-semibold disabled:opacity-50"
                  onClick={handleBlockConfirm}
                  disabled={blockBusy}
                >
                  {blockBusy ? 'Заблокируем…' : 'Заблокировать'}
                </button>
              </div>
            </div>
          </div>
        ) : null}
    </div>
  );
};

export default ChatPopupPage;
