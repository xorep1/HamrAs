"use client";

import { useEffect, useRef, useState } from "react";
import { HostPanel } from "@/components/host-panel";
import { Icon } from "@/components/icons";
import { MAX_FILE_SIZE, MAX_HOST_FILE_SIZE, MAX_MEMORY_FILE_SIZE, MAX_MESSAGE_LENGTH, safeFilename } from "@/lib/protocol.mjs";
import { copyText } from "@/lib/clipboard";
import { initialSnapshot, isBusy, TransferClient, type ChatMessage, type Snapshot, type Transfer } from "@/lib/transfer-client";

// The signaling client owns capture and disk writing. These view types describe only the fields the
// UI reads from the shared snapshot contract (direct save capability, chosen storage, saved name) so
// the page keeps rendering while the client contract lands.
type TransferStatus = Transfer["status"] | "finalizing";
type UiTransfer = Omit<Transfer, "status"> & { status: TransferStatus; storage?: "disk" | "memory"; savedName?: string };
type UiSnapshot = Snapshot & { directSave?: boolean; choosingSave?: boolean };

const fa = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 1 });
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const MAX_LABEL = `${fa.format(MAX_FILE_SIZE / GIB)} گیگابایت`;
const MEMORY_LABEL = `${fa.format(MAX_MEMORY_FILE_SIZE / MIB)} مگابایت`;
const HOST_LABEL = `${fa.format(MAX_HOST_FILE_SIZE / GIB)} گیگابایت`;

function size(bytes: number) {
  if (bytes < 1024) return `${fa.format(bytes)} بایت`;
  if (bytes < MIB) return `${fa.format(bytes / 1024)} کیلوبایت`;
  if (bytes < GIB) return `${fa.format(bytes / MIB)} مگابایت`;
  return `${fa.format(bytes / GIB)} گیگابایت`;
}

const clock = new Intl.DateTimeFormat("fa-IR", { timeStyle: "short" });
const chatTime = (value: number) => clock.format(new Date(value));
const chatStatuses: Record<ChatMessage["status"], string> = {
  pending: "در حال ارسال", sent: "ارسال شد", received: "دریافت شد", error: "ارسال ناموفق",
};

const statuses: Record<string, string> = {
  waiting: "منتظر تأیید گیرنده", connecting: "در حال اتصال مستقیم", transferring: "در حال انتقال",
  finalizing: "در حال نهایی‌سازی",
  complete: "انتقال کامل شد", cancelled: "انتقال لغو شد", error: "انتقال ناموفق",
};

export default function Home() {
  const [state, setState] = useState<Snapshot>(initialSnapshot);
  const [file, setFile] = useState<File | null>(null);
  const [selected, setSelected] = useState("");
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState("");
  const [copied, setCopied] = useState(false);
  const [help, setHelp] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [chatDraft, setChatDraft] = useState("");
  const [copiedChat, setCopiedChat] = useState("");
  const client = useRef<TransferClient | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const dialog = useRef<HTMLDialogElement | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatCopyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const view = state as UiSnapshot;
  const transfer = state.transfer as UiTransfer | null;
  const incoming = state.incoming;
  const directSave = view.directSave === true;
  const choosingSave = view.choosingSave === true;
  const busy = isBusy(state.transfer) || transfer?.status === "finalizing";
  const peer = state.peers.find((item) => item.id === selected);
  const online = state.connection === "online";
  const storage = transfer?.storage;
  // Progress must never read 100% until the file is finalized (written and closed) on the receiver.
  const progress = transfer ? (transfer.status === "complete" ? transfer.progress : Math.min(transfer.progress, 99)) : 0;
  const modeLabel = !transfer ? "" : transfer.direction === "send"
    ? "ارسال مستقیم از این دستگاه"
    : storage === "disk" ? "ذخیرهٔ مستقیم روی دیسک"
      : storage === "memory" ? "دریافت در حافظهٔ مرورگر"
        : "دریافت مستقیم";

  useEffect(() => {
    const service = new TransferClient(setState);
    client.current = service;
    service.start();
    return () => {
      service.destroy(); client.current = null;
      if (copyTimer.current) clearTimeout(copyTimer.current);
      if (chatCopyTimer.current) clearTimeout(chatCopyTimer.current);
    };
  }, []);

  // The dialog also stays open while a native save picker is pending, so the disabled accept button
  // remains visible until the writable stream is ready (or the picker is cancelled).
  const showOffer = !!incoming || choosingSave;
  useEffect(() => {
    if (showOffer) dialog.current?.showModal();
    else dialog.current?.close();
  }, [showOffer]);

  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  function choose(files: FileList | null) {
    if (busy || !files?.length) return;
    if (files.length > 1) { setFileError("در هر نوبت یک فایل انتخاب کنید."); return; }
    if (files[0].size > MAX_FILE_SIZE) { setFileError(`این فایل بزرگ‌تر از ${MAX_LABEL} است.`); return; }
    setFile(files[0]);
    setFileError("");
  }

  // accept() opens the native save picker inside the click gesture and only settles once the
  // writable stream is ready; a cancelled picker rejects the pending request through the client.
  function acceptIncoming() {
    void Promise.resolve(client.current?.accept() as unknown as Promise<void> | void).catch(() => { /* surfaced via snapshot */ });
  }

  function sendMessage() {
    const text = chatDraft;
    if (!selected) { return; }
    // The draft is only cleared once the client accepted the message, so a rejected send loses nothing.
    if (client.current?.sendMessage(text, selected)) setChatDraft("");
  }

  async function copyMessage(item: ChatMessage) {
    if (!await copyText(item.text)) return;
    setCopiedChat(item.id);
    if (chatCopyTimer.current) clearTimeout(chatCopyTimer.current);
    chatCopyTimer.current = setTimeout(() => setCopiedChat(""), 2000);
  }

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(location.origin);
      setCopied(true);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch { setHelp(true); }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#main" aria-label="هم‌رس، صفحه اصلی"><span className="brand-mark"><Icon name="swap" size={27}/></span><span>هم‌رس<span className="brand-latin">HAMRAS</span></span></a>
        <div className={`connection-pill ${online ? "connected" : ""}`} role="status"><span className="dot"/>{online ? "متصل به شبکهٔ محلی" : state.connection === "unsupported" ? "مرورگر پشتیبانی نمی‌شود" : state.connection === "offline" ? "اتصال قطع است؛ تلاش مجدد" : "در حال اتصال به میزبان"}</div>
        <button className="text-button help-button" onClick={() => setHelp(!help)} aria-expanded={help} aria-controls="help">راهنمای اتصال<span className="question-mark">؟</span></button>
      </header>

      <main id="main">
        {help && <section className="help-panel" id="help" aria-label="راهنمای اتصال"><div><h2>یک شبکه، یک آدرس، یک ارتباط مستقیم.</h2><p>همهٔ دستگاه‌ها را به یک وای‌فای یا شبکهٔ کابلی متصل کنید و آدرس IP میزبان را که هنگام اجرای برنامه در ترمینال نمایش داده می‌شود، در مرورگر باز کنید. آدرس localhost فقط روی خود میزبان کار می‌کند.</p><p>فقط کاربران حاضر در همین سایت نمایش داده می‌شوند. شبکهٔ مهمان، جداسازی دستگاه‌ها در مودم یا فایروال ممکن است اتصال مستقیم را مسدود کند. این برنامه برای شبکهٔ مورداعتماد است؛ آن را در اینترنت منتشر نکنید.</p><p>برای فایل‌های بزرگ‌تر از {MEMORY_LABEL}، گیرنده باید با کروم یا اج روی رایانه و در بافت امن باز باشد: آدرس localhost همیشه امن است و کاربر محلی به انتخاب محل ذخیره روی دیسک دسترسی دارد. برای آدرس‌های شبکهٔ محلی میزبان می‌تواند گواهی TLS بدهد؛ هنگام اجرا متغیرهای محیطی TLS_CERT_FILE و TLS_KEY_FILE را تنظیم کنید و سپس همان آدرس https را در دستگاه‌ها باز کنید و گواهی را بپذیرید.</p><p>بخش «پیام متنی» روی همان ارتباط زنده کار می‌کند: پیام فقط به دستگاه انتخاب‌شده می‌رسد، روی سرور ذخیره نمی‌شود و با بستن صفحه پاک می‌شود؛ برای کپی، دکمهٔ کنار هر پیام را بزنید. بخش «متن‌های روی هاست» جداست: متنی که با رمز ذخیره کنید روی سایت می‌ماند و همه در شبکه می‌توانند بخوانند و کپی کنند. بخش «فایل‌ها روی هاست» جداست: فایل تا {HOST_LABEL} روی خود سرور ذخیره می‌شود و تا وقتی حذفش نکنید می‌ماند. آپلود و حذف رمز می‌خواهد، اما فهرست، مشاهده و دانلود برای همهٔ کاربران شبکه بدون رمز باز است؛ پس چیزی را که نمی‌خواهید همه ببینند آپلود نکنید. برای انتقال یک‌بارهٔ خصوصی، همان انتقال مستقیم را استفاده کنید.</p><p>تا پایان انتقال، هر دو صفحه را باز و دستگاه‌ها را بیدار نگه دارید. فایل‌های کوچک تا {MEMORY_LABEL} در حافظهٔ مرورگر گیرنده ساخته می‌شوند؛ قبل از انتقال بعدی آن‌ها را ذخیره کنید. فایل‌های بزرگ‌تر مستقیم روی دیسک گیرنده نوشته می‌شوند و جایی در حافظه نگه داشته نمی‌شوند.</p></div><button className="icon-button" onClick={() => setHelp(false)} aria-label="بستن راهنما"><Icon name="close"/></button></section>}

        <section className="hero">
          <div className="eyebrow"><span/> نزدیک‌تر از همیشه <span className="eyebrow-line"/></div>
          <h1>فایل‌ها اینجا،<br/><span>فاصله‌ها هیچ.</span></h1>
          <p>از این دستگاه به آن دستگاه.<br className="mobile-break"/> مستقیم، ساده، در شبکهٔ خودت.</p>
          <div className="hero-chips"><span><Icon name="shield" size={16}/>انتقال مستقیم بدون ذخیره</span><span><Icon name="link" size={16}/>ارتباط مستقیم</span></div>
          <div className="orbit-art" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit orbit-three"/><div className="orbit-core"><Icon name="swap" size={42}/></div><div className="orbit-node node-one"><Icon name="laptop" size={29}/></div><div className="orbit-node node-two"><Icon name="phone" size={27}/></div><div className="orbit-spark spark-one"/><div className="orbit-spark spark-two"/><span className="orbit-caption">PEER TO PEER / LOCAL NETWORK</span></div>
        </section>

        {(state.error || fileError) && <div className="alert" role="alert" data-testid="alert"><span>{fileError || state.error}</span><button className="icon-button" aria-label="بستن پیام خطا" onClick={() => { setFileError(""); client.current?.dismissError(); }}><Icon name="close" size={18}/></button></div>}

        <div className="workspace">
          <section className="panel send-panel" aria-labelledby="send-title">
            <div className="section-heading"><h2 id="send-title">بفرست، همین حالا.</h2><span className="step-label">۰۱ / انتخاب فایل</span></div>
            <input ref={picker} type="file" className="file-input" aria-label="انتخاب فایل برای ارسال" disabled={busy} onChange={(event) => { choose(event.target.files); event.target.value = ""; }}/>
            <button className={`dropzone ${dragging ? "dragging" : ""} ${file ? "has-file" : ""}`} disabled={busy} onClick={() => picker.current?.click()} onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files); }}>
              <span className="upload-icon"><Icon name={file ? "file" : "upload"} size={32}/></span>
              {file ? <><strong className="chosen-name" dir="auto">{file.name}</strong><span>{size(file.size)} <span className="muted-separator">/</span> برای تغییر، کلیک کنید</span></> : <><strong>فایلت رو اینجا رها کن</strong><span>یا <em>از دستگاهت انتخاب کن</em></span></>}
              <span className="file-limit">هر نوع فایل <span/> حداکثر {MAX_LABEL}</span>
            </button>
            <p className="storage-note" data-testid="storage-note">
              {directSave
                ? <>روی این دستگاه <strong>ذخیرهٔ مستقیم روی دیسک</strong> فعال است: فایل‌های تا {MAX_LABEL} بدون نگه‌داشتن در حافظه، تکه‌تکه روی دیسک گیرنده نوشته می‌شوند.</>
                : <>این مرورگر نمی‌تواند مستقیم روی دیسک بنویسد؛ در حالت بازگشتی فقط فایل‌های کوچک تا {MEMORY_LABEL} در حافظهٔ مرورگر ساخته می‌شوند. برای فایل‌های بزرگ‌تر کروم یا اج روی رایانه با اتصال امن (localhost یا گواهی TLS معتبر) را باز کنید.</>}
            </p>
            <div className="send-bottom"><span>{peer ? <>گیرنده: <strong>{peer.name}</strong></> : "یک دستگاه را از فهرست انتخاب کن"}</span><button className="primary-button" disabled={!file || !peer || !online || busy || !!state.incoming || choosingSave} onClick={() => { if (file && peer) client.current?.request(file, peer); }}>ارسال فایل<Icon name="arrow" size={20}/></button></div>
          </section>

          <section className="panel peers-panel" aria-labelledby="peers-title">
            <div className="section-heading"><h2 id="peers-title">دستگاه‌های نزدیک <span className="count">{fa.format(state.peers.length)}</span></h2><span className="live-label"><span className={`dot ${online ? "pulse" : ""}`}/>{online ? "زنده" : "آفلاین"}</span></div>
            <p className="section-description">روی دستگاه مقصد کلیک کن.</p>
            <div className="peer-list">
              {state.peers.length === 0 ? <div className="empty-peers"><div className="radar-icon"><Icon name="wifi" size={29}/></div><strong>{online ? "منتظر یک همراه..." : "در انتظار اتصال"}</strong><p>همین سایت را روی یک دستگاه دیگر<br/>در شبکهٔ محلی باز کن.</p><button className="text-button accent" onClick={copyAddress}><Icon name={copied ? "check" : "link"} size={16}/>{copied ? "آدرس کپی شد" : "کپی آدرس این صفحه"}</button></div> : state.peers.map((item) => <button key={item.id} className={`peer-card ${selected === item.id ? "selected" : ""}`} onClick={() => setSelected(item.id)} disabled={busy} aria-pressed={selected === item.id} data-testid="peer-card"><span className="device-icon"><Icon name={item.device === "mobile" ? "phone" : "laptop"} size={25}/><span className="dot"/></span><span className="peer-info"><strong dir="auto">{item.name}</strong><small>{item.device === "mobile" ? "موبایل" : "رایانه"}<span> / </span><bdi>{item.id.slice(0, 6)}</bdi></small></span><span className="selection-circle">{selected === item.id && <Icon name="check" size={14}/>}</span></button>)}
            </div>
            <div className="my-device"><span className="my-avatar"><Icon name="laptop" size={20}/></span><div><span className="my-label">این دستگاه / شما</span>{editing ? <form className="rename-form" onSubmit={(event) => { event.preventDefault(); client.current?.rename(draft); setEditing(false); }}><input aria-label="نام دستگاه" autoFocus maxLength={32} value={draft} onChange={(event) => setDraft(event.target.value)} required/><button type="submit" aria-label="ذخیره نام"><Icon name="check" size={18}/></button></form> : <strong dir="auto">{state.name || "در حال اتصال..."}</strong>}</div>{!editing && <button className="text-button rename-button" onClick={() => { setDraft(state.name); setEditing(true); }} aria-label="تغییر نام دستگاه">تغییر نام</button>}</div>
          </section>
        </div>

        <section className="panel chat-panel" aria-labelledby="chat-title" data-testid="chat-panel">

                <div className="chat-list" data-testid="chat-list">
            {state.messages.length === 0
              ? <div className="empty-peers"><div className="radar-icon"><Icon name="chat" size={26}/></div><strong>هنوز پیامی رد و بدل نشده.</strong><p>پیام‌ها فقط تا وقتی این صفحه باز است می‌مانند؛<br/>برای نگه‌داشتن متن، همان متن را روی هاست ذخیره کن.</p></div>
              : state.messages.map((item) => (
                <div className={`chat-row ${item.direction === "send" ? "incoming" : "outgoing"}`} key={item.id} data-testid="chat-row">
                  <div className="chat-bubble">
                    <strong dir="auto">{item.direction === "send" ? "شما" : item.peer}</strong>
                    <p dir="auto">{item.text}</p>
                    <small>
                      <span>{chatTime(item.sentAt)}</span>
                      <span className="muted-separator">/</span>
                      <span className={item.status === "error" ? "status-error" : ""}>{item.detail || chatStatuses[item.status]}</span>
                    </small>
                  </div>
                  <button className="icon-button copy-button" aria-label="کپی" data-testid="chat-copy" onClick={() => void copyMessage(item)}>
                    <Icon name={copiedChat === item.id ? "check" : "copy"} size={16}/>
                  </button>
                </div>
              ))}
          </div>

          <div className="section-heading">
            <h2 id="chat-title">پیام متنی <span className="count">{fa.format(state.messages.length)}</span></h2>
            <span className="step-label">۰۲ / پیام مستقیم</span>
          </div>
          <p className="section-description">
            {peer
              ? <>گیرنده: <strong dir="auto">{peer.name}</strong> — پیام فقط برای همین دستگاه می‌رود و روی سرور ذخیره نمی‌شود.</>
              : "یک دستگاه را از فهرست بالا انتخاب کن تا پیام برایش برود."}
          </p>
          <div className="chat-compose">
            <textarea className="text-input" rows={3} maxLength={MAX_MESSAGE_LENGTH} value={chatDraft} disabled={!peer}
              aria-label="متن پیام" placeholder="متن پیام…"
              onChange={(event) => setChatDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); sendMessage(); } }}/>
            <div className="chat-actions">
              <span>{fa.format(chatDraft.length)} / {fa.format(MAX_MESSAGE_LENGTH)} نویسه<span className="muted-separator">/</span>Ctrl + Enter برای ارسال</span>
              <button className="primary-button" data-testid="chat-send" disabled={!peer || !online || !chatDraft.trim()} onClick={sendMessage}>
                ارسال پیام<Icon name="chat" size={18}/>
              </button>
            </div>
          </div>
          {state.chatError && <p className="host-message error" role="alert" data-testid="chat-error">{state.chatError}</p>}
          
        </section>

        <section className="panel transfer-panel" aria-labelledby="transfer-title">
          <div className="section-heading"><h2 id="transfer-title">جریان انتقال</h2><span className="step-label">{transfer ? transfer.direction === "send" ? "خروجی / ارسال" : "ورودی / دریافت" : "۰۳ / انتقال مستقیم"}</span></div>
          {!transfer ? <div className="empty-transfer"><span className="empty-transfer-icon"><Icon name="swap" size={24}/></span><div><strong>هنوز فایلی در راه نیست.</strong><p>با انتخاب فایل و دستگاه مقصد، اولین انتقال را شروع کن.</p></div><span className="waiting-tag">آمادهٔ انتقال</span></div> : <div className="transfer-content" data-testid="transfer"><div className="transfer-top"><span className={`transfer-file-icon ${transfer.status === "complete" ? "success" : ""}`}><Icon name={transfer.status === "complete" ? "check" : "file"} size={26}/></span><div className="transfer-file"><strong dir="auto">{transfer.file.name}</strong><span>{transfer.direction === "send" ? "به" : "از"} {transfer.peer}<span className="muted-separator">/</span>{size(transfer.file.size)}</span></div><span className={`transfer-status status-${transfer.status}`} role="status" data-testid="transfer-status">{statuses[transfer.status] ?? transfer.status}</span></div><div className="transfer-meta"><span className="mode-badge" data-testid="transfer-mode">{modeLabel}</span>{transfer.status === "finalizing" && <span className="pending-note" role="status" data-testid="finalizing-note">در حال بستن فایل روی دستگاه…</span>}</div><div className="progress-track" role="progressbar" aria-label="پیشرفت انتقال فایل" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><span className={transfer.status === "complete" ? "complete" : ""} style={{ width: `${progress}%` }}/></div><div className="progress-details"><span>{fa.format(progress)}٪<span className="muted-separator">/</span>{size(transfer.bytes)} دریافت‌شده</span><span>{transfer.status === "transferring" && transfer.speed > 0 ? `${size(transfer.speed)} بر ثانیه` : ""}</span>{busy && <button className="cancel-button" onClick={() => client.current?.cancel()}>لغو انتقال</button>}</div>{transfer.detail && <p className="transfer-detail" role="alert">{transfer.detail}</p>}{transfer.status === "complete" && transfer.direction === "receive" && storage === "disk" ? <div className="saved-row" role="status" data-testid="disk-saved"><Icon name="check" size={19}/><p>فایل روی دیسک دستگاه شما ذخیره شد{transfer.savedName ? <> با نام <strong dir="auto">{transfer.savedName}</strong></> : null}. نیازی به ذخیرهٔ دوباره نیست.</p></div> : transfer.status === "complete" && transfer.url ? <div className="download-row"><a className="primary-button" href={transfer.url} download={safeFilename(transfer.file.name)}><Icon name="download" size={18}/>ذخیرهٔ فایل</a><p>قبل از بستن صفحه یا انتقال بعدی، فایل را ذخیره کن.</p></div> : null}{transfer.status === "waiting" && <p className="transfer-detail">گیرنده باید درخواست را بپذیرد؛ تا آن زمان فایلی فرستاده نمی‌شود.</p>}{transfer.status === "finalizing" && <p className="transfer-detail">همهٔ تکه‌ها روی دیسک نوشته شد؛ پیشرفت تا بسته‌شدن کامل فایل ۱۰۰٪ نشان داده نمی‌شود.</p>}</div>}
        </section>

        <HostPanel/>

        <div className="bottom-note"><Icon name="shield" size={17}/><p>در انتقال مستقیم، فایل‌ها بین دو دستگاه جابه‌جا می‌شوند و چیزی روی سرور نمی‌ماند. فایل‌های بخش «روی هاست» عمداً روی همین دستگاه ذخیره می‌شوند و هر کسی در شبکه می‌تواند دانلودشان کند. <span>فقط در شبکه‌ای که به آن اعتماد داری استفاده کن.</span></p></div>
        <footer><span>هم‌رس <span className="footer-divider">/</span> راه کوتاه‌ترِ رسیدن.</span><span className="footer-tech" dir="ltr">LOCAL FIRST. <span>DIRECT BY DESIGN.</span></span></footer>
      </main>

      <dialog ref={dialog} className="receive-dialog" onCancel={(event) => { event.preventDefault(); client.current?.reject(); }} aria-labelledby="incoming-title" aria-describedby="incoming-description">
        {incoming && <><div className="incoming-icon"><Icon name="download" size={32}/></div><span className="eyebrow">یک فایل در راه است</span><h2 id="incoming-title">درخواست دریافت فایل</h2><p id="incoming-description"><strong>{incoming.name}</strong> می‌خواهد این فایل را برای شما بفرستد.</p><div className="incoming-file"><Icon name="file" size={25}/><div><strong dir="auto">{incoming.file.name}</strong><small>{size(incoming.file.size)}</small></div></div><p className="dialog-note">فقط فایل فرستنده‌ای را بپذیر که می‌شناسی. نام دستگاه تضمین هویت نیست. {directSave ? `این فایل مستقیم روی دیسک دستگاه تو نوشته می‌شود؛ محل ذخیره را خودت انتخاب می‌کنی.` : `نبود امکان ذخیرهٔ مستقیم روی دیسک در این مرورگر: فقط فایل‌های تا ${MEMORY_LABEL} در حافظهٔ مرورگر دریافت می‌شوند.`}</p>{choosingSave && <p className="dialog-note pending-note" role="status" data-testid="picker-pending">در حال انتخاب محل ذخیره روی دستگاه تو…</p>}<div className="dialog-actions"><button className="primary-button" onClick={acceptIncoming} disabled={choosingSave} aria-busy={choosingSave} autoFocus={!choosingSave}>پذیرفتن و دریافت<Icon name="download" size={18}/></button><button className="secondary-button" onClick={() => client.current?.reject()} disabled={choosingSave}>رد درخواست</button></div></>}
        {!incoming && choosingSave && <><div className="incoming-icon"><Icon name="download" size={32}/></div><span className="eyebrow">یک فایل در راه است</span><h2 id="incoming-title">آماده‌سازی دریافت فایل</h2><p id="incoming-description">محل ذخیره را انتخاب می‌کنی؛ به‌محض آماده‌شدن مقصد، دریافت آغاز می‌شود.</p><p className="dialog-note pending-note" role="status" data-testid="picker-pending">در حال انتخاب محل ذخیره روی دستگاه تو…</p><div className="dialog-actions"><button className="primary-button" onClick={acceptIncoming} disabled aria-busy="true">پذیرفتن و دریافت<Icon name="download" size={18}/></button><button className="secondary-button" onClick={() => client.current?.reject()} disabled>رد درخواست</button></div></>}
      </dialog>
    </div>
  );
}
