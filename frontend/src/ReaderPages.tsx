import { useEffect, useState } from "react";
import { ArrowLeft, Flower2 } from "lucide-react";
import { ApiError, request } from "./lib/http";
import { useReaderLibrary } from "./hooks/useReaderLibrary";
import { LanguageSelect, useI18n } from "./i18n";
import { useSite } from "./site";
import { ReadingLightSwitch } from "./theme";
import MessageFeed from "./components/MessageFeed";
import LandscapeFooter from "./components/editorial/LandscapeFooter";
import type { Message } from "./types";

export default function ReaderPages({ id }: { id?: string }) {
  const { t } = useI18n();
  const site = useSite();
  const library = useReaderLibrary();
  const [messages, setMessages] = useState<Message[]>([]);
  const [missing, setMissing] = useState<number[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [limit, setLimit] = useState(24);
  const [retry, setRetry] = useState(0);
  const ids = id ? [Number(id)] : library.ids.slice(0, limit);
  const signature = ids.join(",");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setMessages((current) =>
      current.filter((message) => ids.includes(message.id)),
    );
    setMissing([]);
    const fetchAll = async () => {
      const loaded: Message[] = [];
      const unavailable: number[] = [];
      // Small batches avoid hundreds of simultaneous requests for a large library.
      for (let offset = 0; offset < ids.length; offset += 4) {
        const batch = await Promise.all(
          ids.slice(offset, offset + 4).map(async (value) => {
            try {
              return await request<Message>(`/api/public/messages/${value}`, {
                signal: controller.signal,
              });
            } catch (e) {
              if (e instanceof ApiError && e.status === 404) {
                unavailable.push(value);
                return null;
              }
              throw e;
            }
          }),
        );
        loaded.push(
          ...batch.filter((value): value is Message => value !== null),
        );
      }
      if (!controller.signal.aborted) {
        setMessages(loaded);
        setMissing(unavailable);
      }
    };
    void fetchAll()
      .catch(() => {
        if (!controller.signal.aborted) setError("暂时无法加载，请重试");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [signature, retry]);
  return (
    <div className="public-page">
      <a className="skip-link" href="#message-list">
        {t("跳到消息列表")}
      </a>
      <header className="pub-header">
        <div className="pub-header-inner">
          <a className="pub-brand" href="/">
            <Flower2 size={26} />
            <span className="pub-brand-copy">
              <strong className="pub-brand-name">{site.name}</strong>
              <span className="pub-brand-badge">signal loom</span>
            </span>
          </a>
          <div className="pub-header-actions">
            <a href="/saved">{t("收藏")}</a>
            <LanguageSelect />
            <ReadingLightSwitch />
          </div>
        </div>
      </header>
      <section className="editorial-wrap reader-detail">
        <a href="/" className="reader-back">
          <ArrowLeft size={16} />
          {t("返回阅读")}
        </a>
        <h1>{id ? t("阅读资讯") : t("我的收藏")}</h1>
        {!id && <p>{t("收藏保存在本机，不会跨设备同步。")}</p>}
        {error && (
          <div className="pub-notice" role="alert">
            {t(error)}
            <button onClick={() => setRetry((n) => n + 1)}>{t("重试")}</button>
          </div>
        )}
        {missing.length > 0 && (
          <div className="pub-notice" role="status">
            {t(id ? "消息不可用或未公开" : "部分收藏已不可用")}
            {!id && (
              <button onClick={() => library.remove(missing)}>
                {t("移除不可用收藏")}
              </button>
            )}
          </div>
        )}
        {!id && !loading && !library.ids.length ? (
          <div className="pub-empty">
            <strong>{t("还没有收藏")}</strong>
            <p>{t("点击消息上的书签按钮，留住想再读的内容。")}</p>
          </div>
        ) : (
          <MessageFeed
            messages={messages}
            initialLoading={loading && messages.length === 0}
            loadingMore={loading && messages.length > 0}
            hasMore={!id && library.ids.length > limit}
            onLoadMore={() => setLimit((n) => n + 24)}
          />
        )}
      </section>
      <LandscapeFooter />
    </div>
  );
}
