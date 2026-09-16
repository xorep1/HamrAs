"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { MAX_HOST_FILE_SIZE } from "@/lib/protocol.mjs";
import { copyText } from "@/lib/clipboard";
import { checkHostPassword, deleteHostFile, deleteHostText, hostDownloadUrl, hostViewUrl, listHostFiles, listHostTexts, MAX_HOST_TEXT, saveHostText, uploadHostFile, type HostFile, type HostStats, type HostText } from "@/lib/host-files";

const fa = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 1 });
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const HOST_LIMIT_LABEL = `${fa.format(MAX_HOST_FILE_SIZE / GIB)} گیگابایت`;

function size(bytes: number) {
  if (bytes < 1024) return `${fa.format(bytes)} بایت`;
  if (bytes < MIB) return `${fa.format(bytes / 1024)} کیلوبایت`;
  if (bytes < GIB) return `${fa.format(bytes / MIB)} مگابایت`;
  return `${fa.format(bytes / GIB)} گیگابایت`;
}
const when = (value: number) => new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));

export function HostPanel() {
  const [files, setFiles] = useState<HostFile[]>([]);
  const [stats, setStats] = useState<HostStats | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [sent, setSent] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [texts, setTexts] = useState<HostText[]>([]);
  const [draft, setDraft] = useState("");
  const [savingText, setSavingText] = useState(false);
  const [busyTextId, setBusyTextId] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const picker = useRef<HTMLInputElement | null>(null);
  const handle = useRef<{ abort(): void } | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      // Files and stored texts are two separate catalogues on the same host store, read together.
      const [listing, stored] = await Promise.all([listHostFiles(signal), listHostTexts(signal)]);
      setFiles(listing.files);
      setStats(listing.stats);
      setTexts(stored);
    } catch (cause) {
      if ((cause as Error)?.name !== "AbortError") setError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // Loading the two catalogues on mount is exactly what this effect is for; the rule cannot see
    // through the await inside refresh(), so it is silenced here rather than restructuring the fetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh(controller.signal);
    return () => { controller.abort(); if (copyTimer.current) clearTimeout(copyTimer.current); };
  }, [refresh]);

  function choose(chosen: FileList | null) {
    if (!chosen?.length) return;
    if (chosen.length > 1) { setError("در هر نوبت یک فایل را آپلود کنید."); return; }
    if (chosen[0].size > MAX_HOST_FILE_SIZE) { setError(`این فایل بزرگ‌تر از ${HOST_LIMIT_LABEL} است.`); return; }
    setFile(chosen[0]);
    setError("");
    setNotice("");
  }

  async function unlock() {
    if (!password) { setError("رمز آپلود را وارد کنید."); return; }
    setChecking(true);
    setError("");
    try {
      await checkHostPassword(password);
      setUnlocked(true);
      setNotice("رمز تأیید شد؛ می‌توانید آپلود کنید.");
    } catch (cause) {
      setUnlocked(false);
      setError((cause as Error).message);
    } finally { setChecking(false); }
  }

  async function upload() {
    if (!file || uploading) return;
    setUploading(true);
    setError("");
    setNotice("");
    setSent(0);
    const task = uploadHostFile(file, password, (loaded) => setSent(loaded));
    handle.current = task;
    try {
      const saved = await task.promise;
      setNotice(`«${saved.name}» روی هاست ذخیره شد.`);
      setFile(null);
      setUnlocked(true);
      await refresh();
    } catch (cause) {
      const problem = cause as Error;
      if (problem.name === "AbortError") setNotice("آپلود لغو شد.");
      else {
        setError(problem.message);
        if (/رمز/.test(problem.message)) setUnlocked(false);
      }
    } finally {
      handle.current = null;
      setUploading(false);
      setSent(0);
    }
  }

  async function remove(target: HostFile) {
    if (!password) { setError("برای حذف، رمز را وارد کنید."); return; }
    setBusyId(target.id);
    setError("");
    try {
      await deleteHostFile(target.id, password);
      setNotice(`«${target.name}» حذف شد.`);
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally { setBusyId(""); }
  }

  async function saveText() {
    const text = draft;
    if (!text.trim()) { setError("متن پیام خالی است."); return; }
    if (text.length > MAX_HOST_TEXT) { setError(`متن پیام نمی‌تواند بیش از ${fa.format(MAX_HOST_TEXT)} نویسه باشد.`); return; }
    if (!password) { setError("برای ذخیرهٔ متن، رمز را وارد کنید."); return; }
    setSavingText(true);
    setError("");
    setNotice("");
    try {
      await saveHostText(text, password);
      setDraft("");
      setUnlocked(true);
      setNotice("متن روی هاست ذخیره شد و از همین حالا روی سایت نمایش داده می‌شود.");
      await refresh();
    } catch (cause) {
      const problem = cause as Error;
      setError(problem.message);
      if (/رمز/.test(problem.message)) setUnlocked(false);
    } finally { setSavingText(false); }
  }

  async function removeText(target: HostText) {
    if (!password) { setError("برای حذف متن، رمز را وارد کنید."); return; }
    setBusyTextId(target.id);
    setError("");
    try {
      await deleteHostText(target.id, password);
      setNotice("متن از روی هاست حذف شد.");
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally { setBusyTextId(""); }
  }

  async function copy(target: HostText) {
    const copied = await copyText(target.text);
    setNotice(copied ? "متن کپی شد." : "");
    if (!copied) { setError("کپی خودکار در این مرورگر ممکن نشد؛ متن را دستی انتخاب کنید."); return; }
    setError("");
    setCopiedId(target.id);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedId(""), 2000);
  }

  const percent = file && file.size > 0 ? Math.min(100, Math.floor(sent / file.size * 100)) : 0;

  return (
    <section className="panel host-panel" aria-labelledby="host-title" data-testid="host-panel">
      <div className="section-heading">
        <h2 id="host-title">فایل‌ها روی هاست <span className="count">{fa.format(files.length)}</span></h2>
        <span className="step-label">۰۴ / فایل روی سرور</span>
      </div>
      <p className="section-description">
        این بخش برخلاف انتقال مستقیم، فایل را <strong>روی خود هاست</strong> نگه می‌دارد: آپلود رمز می‌خواهد، ولی دیدن و دانلود برای همهٔ کاربران شبکه آزاد است.
      </p>

      <div className="host-upload">
        <input ref={picker} type="file" className="file-input" aria-label="انتخاب فایل برای آپلود روی هاست" disabled={uploading} onChange={(event) => { choose(event.target.files); event.target.value = ""; }}/>
        <button className={`dropzone compact ${dragging ? "dragging" : ""} ${file ? "has-file" : ""}`} disabled={uploading} onClick={() => picker.current?.click()}
          onDragOver={(event) => { event.preventDefault(); if (!uploading) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); if (!uploading) choose(event.dataTransfer.files); }}>
          <span className="upload-icon"><Icon name={file ? "file" : "upload"} size={26}/></span>
          {file
            ? <><strong className="chosen-name" dir="auto">{file.name}</strong><span>{size(file.size)} <span className="muted-separator">/</span> برای تغییر، کلیک کنید</span></>
            : <><strong>فایل را برای آپلود روی هاست رها کن</strong><span>یا <em>از دستگاهت انتخاب کن</em></span></>}
          <span className="file-limit">حداکثر {HOST_LIMIT_LABEL} برای هر فایل</span>
        </button>

        <div className="host-auth">
          <label htmlFor="host-password">رمز آپلود</label>
          <div className="host-auth-row">
            <input id="host-password" type="password" inputMode="numeric" autoComplete="off" placeholder="رمز را وارد کنید"
              value={password} disabled={uploading} onChange={(event) => { setPassword(event.target.value); setUnlocked(false); }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void unlock(); } }}/>
            <button className="secondary-button" onClick={() => void unlock()} disabled={!password || checking || uploading}>
              {unlocked ? <><Icon name="check" size={16}/>تأیید شد</> : checking ? "بررسی..." : "بررسی رمز"}
            </button>
          </div>
          <p className="host-hint">رمز فقط برای آپلود و حذف لازم است؛ برای دانلود و مشاهده هیچ رمزی خواسته نمی‌شود.</p>
        </div>

        {uploading && (
          <div className="host-progress" data-testid="host-progress">
            <div className="progress-track" role="progressbar" aria-label="پیشرفت آپلود روی هاست" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${percent}%` }}/>
            </div>
            <div className="progress-details">
              <span>{fa.format(percent)}٪<span className="muted-separator">/</span>{size(sent)} ارسال‌شده</span>
              <button className="cancel-button" onClick={() => handle.current?.abort()}>لغو آپلود</button>
            </div>
          </div>
        )}

        <div className="host-actions">
          <span>
            {stats ? <>{fa.format(stats.files)} فایل <span className="muted-separator">/</span> {size(stats.bytes)} اشغال‌شده <span className="muted-separator">/</span> {size(stats.remaining)} آزاد</> : "در حال خواندن وضعیت هاست..."}
          </span>
          <button className="primary-button" onClick={() => void upload()} disabled={!file || !password || uploading} data-testid="host-upload-button">
            آپلود روی هاست<Icon name="upload" size={18}/>
          </button>
        </div>
      </div>

      {error && <p className="host-message error" role="alert" data-testid="host-error">{error}</p>}
      {notice && !error && <p className="host-message" role="status" data-testid="host-notice">{notice}</p>}

      <div className="host-list" data-testid="host-list">
        {files.length === 0
          ? <div className="empty-peers"><div className="radar-icon"><Icon name="file" size={26}/></div><strong>هنوز فایلی روی هاست نیست.</strong><p>اولین فایل را با رمز آپلود کن؛<br/>بعد از آن همه در شبکه می‌توانند دانلودش کنند.</p></div>
          : files.map((item) => (
            <div className="host-row" key={item.id} data-testid="host-row">
              <span className="host-row-icon"><Icon name="file" size={22}/></span>
              <div className="host-row-info">
                <strong dir="auto">{item.name}</strong>
                <small>{size(item.size)}<span className="muted-separator">/</span>{when(item.uploadedAt)}</small>
              </div>
              <div className="host-row-actions">
                {item.viewable && <a className="text-button" href={hostViewUrl(item)} target="_blank" rel="noreferrer noopener">مشاهده</a>}
                <a className="secondary-button" href={hostDownloadUrl(item)} download={item.name}><Icon name="download" size={16}/>دانلود</a>
                <button className="icon-button" onClick={() => void remove(item)} disabled={busyId === item.id || uploading} aria-label={`حذف ${item.name}`} title="حذف (رمز لازم است)"><Icon name="close" size={16}/></button>
              </div>
            </div>
          ))}
      </div>

      <div className="host-texts">
        <div className="section-heading">
          <h3 id="host-text-title">متن‌های روی هاست <span className="count">{fa.format(texts.length)}</span></h3>
          <span className="step-label">۰۵ / متن عمومی</span>
        </div>
        <p className="section-description">
          متنی که اینجا ذخیره کنی روی سایت نمایش داده می‌شود و هر کسی در شبکه می‌تواند بخواند و با یک کلیک کپی کند. ذخیره و حذف رمز می‌خواهد؛ خواندن رمز ندارد.
        </p>
        <textarea id="host-text" className="text-input" rows={4} maxLength={MAX_HOST_TEXT} value={draft} disabled={savingText}
          aria-label="متن برای ذخیره روی هاست" placeholder="متن پیام یا یادداشت عمومی…"
          onChange={(event) => { setDraft(event.target.value); setNotice(""); }}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void saveText(); } }}/>
        <div className="host-actions">
          <span>{fa.format(draft.length)} / {fa.format(MAX_HOST_TEXT)} نویسه<span className="muted-separator">/</span>Ctrl + Enter برای ذخیره</span>
          <button className="primary-button" data-testid="host-text-save" onClick={() => void saveText()} disabled={!draft.trim() || !password || savingText}>
            ذخیره روی هاست<Icon name="upload" size={18}/>
          </button>
        </div>
        <div className="host-list" data-testid="host-text-list">
          {texts.length === 0
            ? <div className="empty-peers"><div className="radar-icon"><Icon name="chat" size={26}/></div><strong>هنوز متنی روی هاست نیست.</strong><p>اولین متن را با رمز ذخیره کن؛<br/>بعد از آن روی سایت نمایش داده می‌شود.</p></div>
            : texts.map((item) => (
              <div className="text-card" key={item.id} data-testid="host-text-row">
                <p className="text-body" dir="auto">{item.text}</p>
                <div className="text-foot">
                  <small>{when(item.createdAt)}</small>
                  <div className="text-actions">
                    <button className="secondary-button" data-testid="host-text-copy" onClick={() => void copy(item)}>
                      <Icon name={copiedId === item.id ? "check" : "copy"} size={16}/>{copiedId === item.id ? "کپی شد" : ""}
                    </button>
                    <button className="icon-button" aria-label="حذف متن" title="حذف (رمز لازم است)" data-testid="host-text-delete" onClick={() => void removeText(item)} disabled={busyTextId === item.id || savingText}>
                      <Icon name="close" size={16}/>
                    </button>
                  </div>
                </div>
              </div>
            ))}
        </div>
      </div>
    </section>
  );
}
