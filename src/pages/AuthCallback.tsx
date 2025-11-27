import { useMemo } from "react";
import { Link, useLocation } from "react-router-dom";

function parseParams(hash: string, search: string) {
  if (hash && hash.startsWith("#")) {
    return new URLSearchParams(hash.substring(1));
  }
  if (search && search.startsWith("?")) {
    return new URLSearchParams(search.substring(1));
  }
  return new URLSearchParams();
}

function resolveState(params: URLSearchParams) {
  const error = params.get("error") ?? params.get("error_code");
  const errorDescription = params.get("error_description") ?? "";
  const type = params.get("type") ?? "";
  const success = !error && params.has("access_token");

  if (success) {
    const action = type === "signup" ? "Регистрация подтверждена" : "Успешный вход";
    return {
      kind: "success" as const,
      title: action,
      message: "Адрес электронной почты подтверждён. Вернитесь в приложение Synastry и войдите под своим логином.",
      details: params.get("email") ? `Для учётной записи: ${params.get("email")}` : null,
    };
  }

  if (error) {
    if (error === "access_denied" && params.get("error_code") === "otp_expired") {
      return {
        kind: "warning" as const,
        title: "Ссылка уже была использована",
        message: "Похоже, ссылка подтверждения уже применена или истекла. Если вы уже вошли в приложение и видите свой аккаунт — всё в порядке.",
        details: "Если вход не выполнен, запросите новое письмо подтверждения из приложения или обратитесь в поддержку.",
      };
    }

    return {
      kind: "error" as const,
      title: "Не удалось подтвердить email",
      message: errorDescription || "Ссылка подтверждения недействительна. Попробуйте запросить новое письмо.",
      details: `Код ошибки: ${error}.`,
    };
  }

  return {
    kind: "info" as const,
    title: "Проверка email",
    message: "Эта страница используется для подтверждения почты. Вернитесь в приложение, чтобы завершить вход.",
    details: null,
  };
}

export default function AuthCallbackPage() {
  const location = useLocation();
  const state = useMemo(() => {
    const params = parseParams(location.hash, location.search);
    return resolveState(params);
  }, [location.hash, location.search]);

  const colorClasses = {
    success: "bg-emerald-500/15 border-emerald-400/40 text-emerald-100",
    warning: "bg-amber-500/10 border-amber-400/40 text-amber-100",
    error: "bg-red-500/15 border-red-400/40 text-red-100",
    info: "bg-slate-700/40 border-slate-500/50 text-slate-100",
  } as const;

  const boxClass = colorClasses[state.kind] ?? colorClasses.info;

  return (
    <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center px-4">
      <div className="w-full max-w-lg space-y-6 text-center">
        <div className={`rounded-2xl border px-6 py-8 shadow-lg ${boxClass}`}>
          <h1 className="text-2xl font-semibold mb-3">{state.title}</h1>
          <p className="text-sm leading-relaxed text-white/90">{state.message}</p>
          {state.details && <p className="mt-3 text-xs text-white/70 whitespace-pre-wrap">{state.details}</p>}
        </div>
        <div className="text-sm text-white/70 space-y-3">
          <p>Можно закрыть эту вкладку и вернуться в настольное приложение Synastry.</p>
          <p>
            Если письмо нужно отправить заново, откройте приложение и выберите «Отправить повторно». Возникли сложности?
            Напишите на <a className="underline" href="mailto:pilot.vt@mail.ru">pilot.vt@mail.ru</a>.
          </p>
        </div>
        <div>
          <Link
            to="/"
            className="inline-flex items-center gap-2 rounded-lg border border-white/20 px-4 py-2 text-sm text-white/80 hover:bg-white/10"
          >
            Вернуться на страницу входа
          </Link>
        </div>
      </div>
    </div>
  );
}
