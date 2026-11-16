import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { errorMessage, post, request, subjectUrl } from "../../utils/api";
import { Modal } from "../../components/Shared";
import { useOperations } from "../../hooks/useWorkspace";
import "./accounts.css";

const accountSchema = z.object({
  user: z.object({ id: z.string(), email: z.string() }).nullable(),
  importedSubjects: z.number().optional(),
  legacySubjects: z.number().optional(),
  restoredSubjectId: z.string().optional(),
});
const accountTabId = crypto.randomUUID();
const AccountContext = createContext<z.infer<typeof accountSchema> | null>(
  null,
);

export const AccountProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const account = useQuery({
    queryKey: ["account"],
    queryFn: () => request("/api/account", accountSchema),
    staleTime: Infinity,
    retry: false,
  });
  useEffect(() => {
    const channel = new BroadcastChannel("learnmap.account");
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data !== accountTabId) window.location.reload();
    };
    return () => channel.close();
  }, []);
  if (account.isPending)
    return <p role="status">학습 공간을 준비하고 있습니다.</p>;
  if (account.isError)
    return (
      <div role="alert">
        <p>{errorMessage(account.error)}</p>
        <button onClick={() => void account.refetch()}>다시 시도</button>
      </div>
    );
  return (
    <AccountContext.Provider value={account.data}>
      {children}
    </AccountContext.Provider>
  );
};

export const AccountButton = () => {
  const account = useContext(AccountContext);
  const operations = useOperations();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const hasOpened = useRef(false);
  useEffect(() => {
    if (open) hasOpened.current = true;
    else if (hasOpened.current) button.current?.focus();
  }, [open]);
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const handleSubmit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      let legacySubjectId: string | null = null;
      try {
        legacySubjectId = localStorage.getItem("learnmap.subjectId");
      } catch {
        /* Browser storage is optional. */
      }
      await post(
        `/api/account/${account?.user ? "logout" : register ? "register" : "login"}`,
        accountSchema,
        { email, password, legacySubjectId },
      );
      const channel = new BroadcastChannel("learnmap.account");
      channel.postMessage(accountTabId);
      channel.close();
      window.location.assign("/");
    } catch (error) {
      setError(errorMessage(error));
      setBusy(false);
    }
  };
  return (
    <>
      <button
        ref={button}
        className="secondary compact account-button"
        disabled={operations.busy}
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      >
        {account?.user ? "내 계정" : "로그인"}
      </button>
      {open && (
        <Modal
          titleId="account-title"
          busy={busy}
          error={error}
          onClose={() => setOpen(false)}
        >
          <form
            className="account-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSubmit();
            }}
          >
            <h2 id="account-title">
              {account?.user ? "내 계정" : register ? "계정 만들기" : "로그인"}
            </h2>
            {account?.user ? (
              <>
                <p className="account-email">{account.user.email}</p>
                <p>
                  지도, 자료와 학습 기록이 계정에 저장됩니다. 다른 기기에서도
                  같은 계정으로 로그인하세요.
                </p>
                <p>
                  로그아웃하면 이 기기에서 비로그인 상태로 계속 이용할 수
                  있습니다.
                </p>
              </>
            ) : (
              <>
                <p>
                  가입 없이도 이용할 수 있습니다. 로그인하면 이 브라우저에서
                  만든 지도를 계정에 자동으로 합쳐 저장합니다.
                </p>
                <div className="account-fields">
                  <label>
                    이메일
                    <input
                      type="email"
                      autoComplete="username"
                      required
                      maxLength={254}
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      disabled={busy}
                    />
                  </label>
                  <label>
                    비밀번호
                    <input
                      type="password"
                      aria-describedby="account-password-hint"
                      autoComplete={
                        register ? "new-password" : "current-password"
                      }
                      required
                      minLength={10}
                      maxLength={128}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      disabled={busy}
                    />
                  </label>
                  <small id="account-password-hint">
                    비밀번호는 10자 이상 입력해 주세요.
                  </small>
                </div>
              </>
            )}
            <div className="account-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                닫기
              </button>
              <button className="primary" disabled={busy}>
                {busy
                  ? "처리 중…"
                  : account?.user
                    ? "로그아웃"
                    : register
                      ? "계정 만들기"
                      : "로그인"}
              </button>
            </div>
            {!account?.user && (
              <button
                type="button"
                className="account-switch"
                disabled={busy}
                onClick={() => {
                  setRegister(!register);
                  setError("");
                }}
              >
                {register
                  ? "이미 계정이 있나요? 로그인"
                  : "계정이 없나요? 계정 만들기"}
              </button>
            )}
          </form>
        </Modal>
      )}
    </>
  );
};

export const AccountStorageNotice = () => {
  const account = useContext(AccountContext);
  return (
    <div className="sidebar-note">
      <span className="pill neutral">
        {account?.user ? "계정 동기화 사용 중" : "비로그인 학습 공간"}
      </span>
      <p>
        {account?.user
          ? "지도와 학습 기록을 다른 기기에서도 이어갈 수 있습니다."
          : "이 브라우저에서 계속 이용하거나, 로그인해 다른 기기와 동기화하세요."}
      </p>
    </div>
  );
};

export const AccountRecovery = () => {
  const account = useContext(AccountContext);
  const operations = useOperations();
  if (account?.user || !account?.legacySubjects) return null;
  return (
    <aside className="account-recovery" aria-label="이전 학습 공간">
      <div>
        <strong>
          이전에 저장된 학습 공간 {account.legacySubjects}개를 찾았습니다.
        </strong>
        <p>
          로그인 없이 다시 열 수 있습니다. 자료와 학습 기록도 함께 불러옵니다.
        </p>
      </div>
      <button
        className="secondary compact"
        disabled={operations.busy}
        onClick={() => {
          void operations.run(
            "저장된 학습 공간을 불러오고 있습니다.",
            async () => {
              let legacySubjectId: string | null = null;
              try {
                legacySubjectId = localStorage.getItem("learnmap.subjectId");
              } catch {
                /* Browser storage is optional. */
              }
              const restored = await post(
                "/api/account/restore",
                accountSchema,
                { legacySubjectId },
              );
              window.location.assign(
                restored.restoredSubjectId
                  ? subjectUrl(restored.restoredSubjectId)
                  : "/",
              );
            },
          );
        }}
      >
        저장된 학습 공간 열기
      </button>
    </aside>
  );
};
