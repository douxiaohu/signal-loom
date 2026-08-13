# Public and Admin Telegram Monitoring Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the current protected security-console SPA into a public Telegram channel information site plus a separate single-admin management center, while fixing image cropping and perceived filter latency and retiring WeCom delivery at runtime.

**Architecture:** Keep one FastAPI container and SQLite database, but split public and admin HTTP routers and build two Vite entry points (`/` and `/admin`). Persist dynamic sources in SQLite, enforce visibility in every public query and media request, and run only collection jobs in production. Keep legacy delivery tables/code read-only for rollback compatibility.

**Tech Stack:** Python 3.11, FastAPI, SQLite WAL, APScheduler, Pillow, React 18, TypeScript, Vite, Vitest, Testing Library, Playwright, Docker Compose, Caddy.

**Repository constraint:** The checkout has no Git baseline and files are untracked. Do not create commits; use the test commands at the end of every task as checkpoints.

---

## File Map

### Backend files to create

- `app/source_service.py` — source URL validation, YAML seed migration, and conversion from stored sources to crawler inputs.
- `app/public_api.py` — unauthenticated, visibility-filtered source/message/media endpoints.
- `app/admin_api.py` — authenticated source CRUD, admin messages, operations, rules, matches, and manual crawl endpoints.

### Backend files to modify

- `app/storage.py` — `sources` schema, source CRUD, public message filtering, and public visibility helpers.
- `app/source_utils.py` — strict canonical Telegram public-source URL validation.
- `app/public_telegram.py` — accept stored source records instead of immutable YAML-only group configuration.
- `app/scheduler.py` — add collection-only coordinator and register only crawl jobs in production.
- `app/media_cache.py` — generate and cache contained image thumbnails and parameterize media URLs.
- `app/main.py` — initialize source migration, include public/admin routers, remove WeCom runtime initialization, and serve both frontend entry points.
- `app/config.py` — keep YAML as a seed, remove webhook/screenshot behavior from active source configuration.

### Frontend files to create

- `frontend/admin/index.html` — admin Vite HTML entry.
- `frontend/src/admin-main.tsx` — admin React bootstrap.
- `frontend/src/PublicApp.tsx` — public information site.
- `frontend/src/public-api.ts` — public source/message API client.
- `frontend/src/components/PublicHeader.tsx` — public brand, search, and admin link.
- `frontend/src/components/PublicSourceList.tsx` — immediate source selection.
- `frontend/src/components/ImageViewer.tsx` — accessible full-image dialog.
- `frontend/test/PublicApp.test.tsx` — public entry, filter cache, visibility, and naming tests.
- `frontend/test/ImageViewer.test.tsx` — complete-image and keyboard dialog tests.

### Frontend files to modify

- `frontend/index.html` — public title and public entry script.
- `frontend/src/main.tsx` — bootstrap `PublicApp`.
- `frontend/src/App.tsx` — become admin-only application and remove delivery UI/data loading.
- `frontend/src/api.ts` — use `/api/admin/*` paths and remove delivery methods.
- `frontend/src/types.ts` — add stored source/public source types and remove active delivery UI types.
- `frontend/src/components/MessageFeed.tsx` — public/admin mode, thumbnail/original links, no delivery footer.
- `frontend/src/components/FilterPanel.tsx` — immediate source commit and neutral placeholder copy.
- `frontend/src/components/OperationsRail.tsx` — remove delivery sections and use monitoring terminology.
- `frontend/src/components/StatusBand.tsx` — admin management-center naming.
- `frontend/src/styles.css` — public/admin layouts, contained media, busy state, and image viewer.
- `frontend/vite.config.ts` — multi-page build inputs.
- `frontend/e2e/console.spec.ts` — public and admin route coverage.

### Tests to create or modify

- Create `tests/test_sources.py`.
- Create `tests/test_public_api.py`.
- Create `tests/test_admin_sources.py`.
- Create `tests/test_collection_runtime.py`.
- Extend `tests/test_media_cache.py`.
- Update `tests/test_security.py`, `tests/test_source_health.py`, and `tests/test_alert_api.py` for admin route names.

---

### Task 1: Persist Sources and Seed Existing YAML

**Files:**
- Create: `app/source_service.py`
- Create: `tests/test_sources.py`
- Modify: `app/storage.py`
- Modify: `app/config.py`
- Modify: `app/source_utils.py`

- [ ] **Step 1: Write failing storage and migration tests**

```python
class SourceStorageTests(unittest.TestCase):
    def test_seed_sources_is_idempotent_and_existing_sources_are_public(self):
        storage = SQLiteStorage("sqlite:///:memory:")
        storage.init_db()
        groups = [GroupConfig(chat_id=-1, name="One", source="https://t.me/one", source_type="telegram_public")]
        seed_sources_from_groups(storage, groups)
        seed_sources_from_groups(storage, groups)
        sources = storage.list_sources()
        self.assertEqual(len(sources), 1)
        self.assertTrue(sources[0].enabled)
        self.assertTrue(sources[0].public_visible)

    def test_new_source_defaults_private_and_url_is_immutable(self):
        source = storage.create_source(name="Two", source_url="https://t.me/two")
        self.assertFalse(source.public_visible)
        with self.assertRaises(TypeError):
            storage.update_source(source.chat_id, source_url="https://t.me/other")
```

- [ ] **Step 2: Run the tests and verify the expected red state**

Run:

```bash
.venv/bin/python -m unittest tests.test_sources -v
```

Expected: import or attribute failure because `StoredSource`, `create_source`, and `seed_sources_from_groups` do not exist.

- [ ] **Step 3: Add the `sources` schema and typed storage API**

Add this schema in `SQLiteStorage.init_db()`:

```sql
CREATE TABLE IF NOT EXISTS sources (
    chat_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    source_url TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL DEFAULT 'telegram_public',
    enabled INTEGER NOT NULL DEFAULT 1,
    public_visible INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_visibility
    ON sources(enabled, public_visible, name);
```

Add strict canonicalization in `app/source_utils.py`:

```python
TELEGRAM_USERNAME_RE = re.compile(r"^[A-Za-z0-9_]+$")

def canonical_telegram_public_url(source: str) -> str:
    username = normalize_telegram_public_source(source)
    if not username or not TELEGRAM_USERNAME_RE.fullmatch(username):
        raise ValueError("invalid Telegram public source URL")
    return f"https://t.me/{username}"
```

Add a frozen `StoredSource` dataclass, `row_to_source()`, and these concrete methods:

```python
def list_sources(self, *, enabled_only: bool = False, public_only: bool = False) -> list[StoredSource]:
    clauses: list[str] = []
    if enabled_only:
        clauses.append("enabled = 1")
    if public_only:
        clauses.append("public_visible = 1")
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with self._connect() as conn:
        rows = conn.execute(f"SELECT * FROM sources {where} ORDER BY name, chat_id").fetchall()
    return [row_to_source(row) for row in rows]

def get_source(self, chat_id: int) -> StoredSource | None:
    with self._connect() as conn:
        row = conn.execute("SELECT * FROM sources WHERE chat_id = ?", (int(chat_id),)).fetchone()
    return row_to_source(row) if row else None

def create_source(self, *, name: str, source_url: str, public_visible: bool = False) -> StoredSource:
    normalized = canonical_telegram_public_url(source_url)
    chat_id = public_source_chat_id(normalized)
    now = datetime.now(timezone.utc).isoformat()
    with self._connect() as conn:
        conn.execute(
            "INSERT INTO sources(chat_id,name,source_url,source_type,enabled,public_visible,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
            (chat_id, name.strip(), normalized, "telegram_public", 1, int(public_visible), now, now),
        )
    source = self.get_source(chat_id)
    if source is None:
        raise RuntimeError("source insert did not persist")
    return source

def update_source(
    self,
    chat_id: int,
    *,
    name: str | None = None,
    enabled: bool | None = None,
    public_visible: bool | None = None,
) -> StoredSource:
    current = self.get_source(chat_id)
    if current is None:
        raise KeyError(f"source not found: {chat_id}")
    values = (
        name.strip() if name is not None else current.name,
        int(enabled) if enabled is not None else int(current.enabled),
        int(public_visible) if public_visible is not None else int(current.public_visible),
        datetime.now(timezone.utc).isoformat(),
        int(chat_id),
    )
    with self._connect() as conn:
        conn.execute("UPDATE sources SET name=?, enabled=?, public_visible=?, updated_at=? WHERE chat_id=?", values)
    updated = self.get_source(chat_id)
    if updated is None:
        raise RuntimeError("source update did not persist")
    return updated
```

`create_source()` must normalize the URL with `canonical_telegram_public_url()`, derive `chat_id` with `public_source_chat_id()`, and reject duplicate IDs or URLs.

- [ ] **Step 4: Implement idempotent YAML seeding**

Create `seed_sources_from_groups()` in `app/source_service.py`:

```python
def seed_sources_from_groups(storage: SQLiteStorage, groups: Iterable[GroupConfig]) -> int:
    if storage.list_sources():
        return 0
    created = 0
    for group in groups:
        if group.source_type != "telegram_public" or not group.source:
            continue
        storage.create_source(
            name=group.name,
            source_url=group.source,
            public_visible=True,
        )
        created += 1
    return created
```

- [ ] **Step 5: Run focused and full storage tests**

```bash
.venv/bin/python -m unittest tests.test_sources tests.test_storage -v
```

Expected: all tests pass; seeding twice leaves one row and new admin-created sources default private.

---

### Task 2: Introduce Collection-Only Runtime and Retire WeCom Jobs

**Files:**
- Create: `tests/test_collection_runtime.py`
- Modify: `app/scheduler.py`
- Modify: `app/public_telegram.py`
- Modify: `app/main.py`

- [ ] **Step 1: Write failing runtime tests**

```python
def test_scheduler_registers_only_collection_job(self):
    scheduler = create_collection_scheduler(config, collector)
    self.assertEqual([job.id for job in scheduler.get_jobs()], ["crawl_public_sources"])

def test_collector_reads_enabled_sources_each_run(self):
    source = storage.create_source(name="One", source_url="https://t.me/one")
    collector.crawl_public_sources_sync()
    storage.update_source(source.chat_id, enabled=False)
    collector.crawl_public_sources_sync()
    self.assertEqual(crawler.chat_ids, [source.chat_id])
```

- [ ] **Step 2: Verify the tests fail before runtime changes**

```bash
.venv/bin/python -m unittest tests.test_collection_runtime -v
```

Expected: `create_collection_scheduler` and `SourceCollector` are missing.

- [ ] **Step 3: Add `SourceCollector` and collection scheduler**

Add a coordinator that queries `storage.list_sources(enabled_only=True)` on every run:

```python
class SourceCollector:
    def __init__(self, storage: SQLiteStorage, crawler: PublicTelegramCrawler) -> None:
        self.storage = storage
        self.crawler = crawler
        self._lock = asyncio.Lock()

    async def crawl_public_sources(self) -> list[dict[str, object]]:
        async with self._lock:
            return await asyncio.to_thread(self.crawl_public_sources_sync)

    def crawl_public_sources_sync(self) -> list[dict[str, object]]:
        return [self.crawl_source_sync(source.chat_id) for source in self.storage.list_sources(enabled_only=True)]

    def crawl_source_sync(self, chat_id: int) -> dict[str, object]:
        source = self.storage.get_source(chat_id)
        if source is None or not source.enabled:
            raise KeyError(f"enabled source not found: {chat_id}")
        started_at = datetime.now(timezone.utc).isoformat()
        result = self.crawler.crawl_source(source)
        finished_at = datetime.now(timezone.utc).isoformat()
        safe_error = sanitize_error_text(result.error)
        self.storage.record_source_run(
            chat_id=source.chat_id,
            source=source.source_url,
            started_at=started_at,
            finished_at=finished_at,
            fetched_count=result.fetched,
            saved_count=result.saved,
            error=safe_error,
        )
        payload = result.as_dict()
        payload["error"] = safe_error
        return payload
```

`create_collection_scheduler()` must add exactly one interval job with ID `crawl_public_sources`, `next_run_time=datetime.now(timezone.utc)`, `max_instances=1`, and `coalesce=True`.

- [ ] **Step 4: Switch application startup to collection-only dependencies**

In `app/main.py`, stop constructing `WeComClient`, `SummaryImageExporter`, and runtime `Forwarder`. Initialize `PublicTelegramCrawler`, `SourceCollector`, and the collection scheduler after calling `seed_sources_from_groups()`.

Remove the active `/jobs/forward-now`, delivery list, and retry endpoints. Do not drop legacy tables or delete legacy classes.

- [ ] **Step 5: Verify collection works and delivery jobs are absent**

```bash
.venv/bin/python -m unittest tests.test_collection_runtime tests.test_public_telegram tests.test_source_health -v
```

Expected: collection tests pass and no scheduled job ID contains `forward` or `delivery`.

---

### Task 3: Add Public Visibility-Safe API and Admin Source API

**Files:**
- Create: `app/public_api.py`
- Create: `app/admin_api.py`
- Create: `tests/test_public_api.py`
- Create: `tests/test_admin_sources.py`
- Modify: `app/storage.py`
- Modify: `app/main.py`

- [ ] **Step 1: Write failing public boundary tests**

```python
def test_public_api_only_returns_public_sources_and_messages(self):
    public = storage.create_source(name="Public", source_url="https://t.me/public", public_visible=True)
    private = storage.create_source(name="Private", source_url="https://t.me/private", public_visible=False)
    save_message(storage, public.chat_id, "visible")
    save_message(storage, private.chat_id, "secret")
    sources = client.get("/api/public/sources")
    messages = client.get("/api/public/messages?limit=20")
    self.assertEqual(sources.status_code, 200)
    self.assertEqual([item["name"] for item in sources.json()["items"]], ["Public"])
    self.assertNotIn("secret", messages.text)

def test_public_media_rechecks_source_visibility(self):
    response = client.get(f"/api/public/media/{private_message.id}/0?variant=thumbnail")
    self.assertEqual(response.status_code, 404)
```

- [ ] **Step 2: Write failing admin source tests**

```python
def test_admin_can_create_publish_disable_and_crawl_source(self):
    login_admin(client)
    created = client.post("/api/admin/sources", json={"name": "Example", "source_url": "https://t.me/example"})
    self.assertEqual(created.status_code, 201)
    self.assertFalse(created.json()["public_visible"])
    chat_id = created.json()["chat_id"]
    published = client.patch(
        f"/api/admin/sources/{chat_id}",
        headers={"Origin": "http://testserver"},
        json={"public_visible": True},
    )
    self.assertTrue(published.json()["public_visible"])
```

- [ ] **Step 3: Verify both new suites fail**

```bash
.venv/bin/python -m unittest tests.test_public_api tests.test_admin_sources -v
```

Expected: 404 responses because the routers are not included.

- [ ] **Step 4: Add visibility-aware storage queries**

Extend `build_message_filters()` and `list_messages_page()` with `allowed_chat_ids: Sequence[int] | None`. When supplied, append an `IN` clause containing exactly one SQL parameter placeholder per allowed chat ID; an empty list must return an empty page instead of omitting the filter.

Add:

```python
def public_chat_ids(self) -> list[int]:
    return [source.chat_id for source in self.list_sources(enabled_only=True, public_only=True)]
```

- [ ] **Step 5: Implement and include both routers**

`public_api.py` exposes `/api/public/sources`, `/messages`, and `/media/{message_id}/{index}` without session dependencies. Public message serialization must omit `forwarded_at`, health errors, raw data, and internal paths.

`admin_api.py` uses router-level `Depends(require_session)` and `Depends(require_same_origin)` on POST/PATCH actions. Source PATCH accepts only `name`, `enabled`, and `public_visible`; source URL is immutable.

Manual crawl calls `request.app.state.collector.crawl_source(chat_id)` and returns the sanitized source-run result.

- [ ] **Step 6: Apply cache headers without weakening visibility**

For `/api/public/*`, return `Cache-Control: no-cache` and an ETag based on the response payload. Honor `If-None-Match` with `304`. Keep `/api/admin/*` and auth responses at `private, no-store` with `Vary: Cookie`.

- [ ] **Step 7: Run API and security suites**

```bash
.venv/bin/python -m unittest tests.test_public_api tests.test_admin_sources tests.test_security tests.test_same_origin -v
```

Expected: public reads succeed without a cookie, private source content is absent, and every admin mutation rejects a cross-origin request.

---

### Task 4: Generate Contained Thumbnails and Original Media Links

**Files:**
- Modify: `app/media_cache.py`
- Modify: `app/public_api.py`
- Modify: `tests/test_media_cache.py`

- [ ] **Step 1: Write failing thumbnail tests**

```python
def test_thumbnail_preserves_aspect_ratio_and_limits_longest_edge(self):
    original = cache.get(message, 0, variant="original")
    thumbnail = cache.get(message, 0, variant="thumbnail")
    with Image.open(original.path) as source, Image.open(thumbnail.path) as thumb:
        self.assertEqual(source.width / source.height, thumb.width / thumb.height)
        self.assertLessEqual(max(thumb.size), 1200)
        self.assertEqual(thumbnail.media_type, "image/webp")

def test_non_image_thumbnail_returns_original(self):
    self.assertEqual(cache.get(video_message, 0, variant="thumbnail"), cache.get(video_message, 0, variant="original"))
```

- [ ] **Step 2: Verify the tests fail on the missing `variant` argument**

```bash
.venv/bin/python -m unittest tests.test_media_cache -v
```

Expected: `MediaCache.get()` rejects `variant`.

- [ ] **Step 3: Implement deterministic thumbnail generation**

Change the signature to:

```python
def get(self, message: StoredMessage, index: int, *, variant: str = "original") -> CachedMedia:
```

For image originals and `variant == "thumbnail"`, create `<cache-base>.thumb.webp` with Pillow:

```python
with Image.open(original.path) as image:
    image.thumbnail((1200, 1200), Image.Resampling.LANCZOS)
    if image.mode not in {"RGB", "RGBA"}:
        image = image.convert("RGB")
    image.save(tmp_path, "WEBP", quality=82, method=6)
os.replace(tmp_path, thumbnail_path)
```

Use the original for video, audio, document, unsupported image formats, or thumbnail-generation failure.

- [ ] **Step 4: Parameterize serialized media paths**

Change `media_cache_urls_for_message()` and `media_cache_items_for_message()` to accept `base_path` and `variant`. Public message items use thumbnail URLs and include an `original_url`; admin messages use the admin media path.

- [ ] **Step 5: Run media and public API tests**

```bash
.venv/bin/python -m unittest tests.test_media_cache tests.test_public_api -v
```

Expected: aspect ratio is preserved, public private-source checks still apply to both variants, and cached responses remain `nosniff`.

---

### Task 5: Split Vite into Public and Admin Entries

**Files:**
- Create: `frontend/admin/index.html`
- Create: `frontend/src/admin-main.tsx`
- Create: `frontend/src/PublicApp.tsx`
- Create: `frontend/src/public-api.ts`
- Create: `frontend/test/PublicApp.test.tsx`
- Modify: `frontend/index.html`
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/vite.config.ts`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Write failing entry behavior tests**

```tsx
it("loads the public timeline without requesting a session", async () => {
  render(<PublicApp />);
  expect(await screen.findByRole("heading", { name: "Telegram 频道资讯监测平台" })).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalledWith("/api/session", expect.anything());
  expect(screen.queryByLabelText("管理密钥")).not.toBeInTheDocument();
});

it("keeps the key gate on the admin application", async () => {
  render(<App />);
  expect(await screen.findByLabelText("管理密钥")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test and verify public app is missing**

```bash
cd frontend && npm run test -- PublicApp.test.tsx
```

Expected: import failure for `PublicApp`.

- [ ] **Step 3: Add the public API client and public shell**

`public-api.ts` calls only `/api/public/sources` and `/api/public/messages`. `PublicApp` renders the approved title, description, source list, public search/filter controls, message feed, and a low-emphasis `/admin` link.

The public component must never call `fetchSession`, operations, rules, matches, or admin endpoints.

- [ ] **Step 4: Configure the multi-page build**

Use Vite Rollup inputs:

```ts
build: {
  rollupOptions: {
    input: {
      public: resolve(__dirname, "index.html"),
      admin: resolve(__dirname, "admin/index.html")
    }
  }
}
```

`frontend/src/main.tsx` mounts `PublicApp`; `admin/index.html` loads `/src/admin-main.tsx`, which mounts the existing admin `App`.

- [ ] **Step 5: Update FastAPI static routing and build**

Ensure `/api/*` routers are registered before the root static mount. Verify the Vite output contains both `dist/index.html` and `dist/admin/index.html`.

```bash
cd frontend && npm run test -- PublicApp.test.tsx && npm run build
```

Expected: public test passes and both HTML entries exist.

---

### Task 6: Make Filtering Immediate and Cache-Aware

**Files:**
- Modify: `frontend/src/PublicApp.tsx`
- Modify: `frontend/src/components/PublicSourceList.tsx`
- Modify: `frontend/src/components/FilterPanel.tsx`
- Modify: `frontend/test/PublicApp.test.tsx`

- [ ] **Step 1: Write failing cache and loading-state tests**

```tsx
it("switches source immediately and does not show the previous source while loading", async () => {
  render(<PublicApp />);
  await screen.findByText("全部来源消息");
  await user.click(screen.getByRole("radio", { name: /竹新社/ }));
  expect(screen.queryByText("全部来源消息")).not.toBeInTheDocument();
  expect(screen.getByLabelText("正在加载竹新社消息")).toBeInTheDocument();
});

it("shows a cached source immediately and revalidates in the background", async () => {
  await visitSource("zaihuapd");
  await visitSource("tnews365");
  await visitSource("zaihuapd");
  expect(screen.getByText("zaihuapd 缓存消息")).toBeInTheDocument();
  expect(fetchCallsFor("zaihuapd")).toBe(2);
});
```

- [ ] **Step 2: Verify both tests fail against the current filter flow**

```bash
cd frontend && npm run test -- PublicApp.test.tsx
```

Expected: source selection requires explicit submit and stale results remain visible.

- [ ] **Step 3: Implement the bounded query cache**

Use a `Map<string, { page: MessagePage; storedAt: number }>` keyed by normalized source/media/query. Keep at most 20 entries and a 60-second freshness window. On a filter change:

1. Abort the old request.
2. If a cache entry exists, display it immediately and mark the feed `aria-busy=true` while revalidating.
3. If no entry exists, clear stale messages and render a named skeleton.
4. Ignore responses whose request sequence or filter key no longer matches.
5. Save successful first pages in the cache.

- [ ] **Step 4: Make source selection commit immediately**

Pass `onSelectSource(chatId)` separately from draft keyword/media edits. Source radio changes update the URL and committed filter directly; keyword and media use the submit button.

- [ ] **Step 5: Run public interaction tests**

```bash
cd frontend && npm run test -- PublicApp.test.tsx FilterPanel.test.tsx
```

Expected: cache, abort, URL navigation, and source skeleton tests pass.

---

### Task 7: Fix Media Layout and Add Accessible Image Viewer

**Files:**
- Create: `frontend/src/components/ImageViewer.tsx`
- Create: `frontend/test/ImageViewer.test.tsx`
- Modify: `frontend/src/components/MessageFeed.tsx`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/test/MessageFeed.test.tsx`

- [ ] **Step 1: Write failing image behavior tests**

```tsx
it("opens the original image in a dialog and closes with Escape", async () => {
  render(<MessageCard message={photoMessage} />);
  await user.click(screen.getByRole("button", { name: /查看完整图片/ }));
  expect(screen.getByRole("dialog", { name: /图片预览/ })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: /完整图片/ })).toHaveAttribute("src", photoMessage.media_items[0].original_url);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
```

Also assert the rendered image uses class `media-image-contained` and no public card renders “待投递” or “已投递”.

- [ ] **Step 2: Verify the tests fail on current cropped images**

```bash
cd frontend && npm run test -- ImageViewer.test.tsx MessageFeed.test.tsx
```

Expected: dialog is missing and delivery text is present.

- [ ] **Step 3: Implement contained media CSS**

Replace the cropping rules with:

```css
.media-image-contained,
.media-video,
.video-poster img {
  display: block;
  width: 100%;
  height: auto;
  max-height: min(68vh, 720px);
  object-fit: contain;
  background: #06101a;
}
```

Do not set a fixed `aspect-ratio` on still images. Multi-image grids may use two columns only when each item remains at least 280px wide; otherwise use one column.

- [ ] **Step 4: Implement the viewer**

`ImageViewer` uses a native `<dialog>` or an ARIA modal, traps focus, closes on Escape and backdrop click, restores focus to the trigger, and uses the `original_url`. The thumbnail remains `loading="lazy"` and includes accurate source/sender alt text.

- [ ] **Step 5: Run media component tests**

```bash
cd frontend && npm run test -- ImageViewer.test.tsx MessageFeed.test.tsx
```

Expected: contained layout, dialog keyboard behavior, and removal of delivery status all pass.

---

### Task 8: Convert Existing Console into the Admin Management Center

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/components/LoginScreen.tsx`
- Modify: `frontend/src/components/OperationsRail.tsx`
- Modify: `frontend/src/components/StatusBand.tsx`
- Modify: `frontend/test/App.test.tsx`
- Modify: `frontend/test/OperationsRail.test.tsx`
- Modify: `tests/test_alert_api.py`

- [ ] **Step 1: Update tests first for admin naming and removed delivery UI**

```tsx
it("labels the protected route as the management center", async () => {
  render(<App />);
  expect(await screen.findByRole("heading", { name: "频道监测管理中心" })).toBeInTheDocument();
});

it("does not request or render deliveries", async () => {
  render(<App />);
  await screen.findByText("来源健康");
  expect(fetchPaths()).not.toContain("/api/deliveries");
  expect(screen.queryByText(/投递|企业微信/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run admin tests and verify expected failures**

```bash
cd frontend && npm run test -- App.test.tsx OperationsRail.test.tsx
```

Expected: old security-console naming and delivery requests cause failures.

- [ ] **Step 3: Move admin calls to `/api/admin/*` and remove delivery state**

Remove `fetchDeliveries`, `retryDelivery`, delivery state, pending delivery count, and delivery action handlers. Rename alert-facing UI to “监测规则” and “命中记录”; keep internal database/API model names if changing them would create migration risk.

Add source-management controls for name, enabled, public-visible, add source, and crawl-now. State-changing requests include same-origin cookies and rely on the existing session.

- [ ] **Step 4: Run admin frontend and API tests**

```bash
cd frontend && npm run test -- App.test.tsx OperationsRail.test.tsx
cd .. && .venv/bin/python -m unittest tests.test_alert_api tests.test_admin_sources -v
```

Expected: management naming, source actions, rule actions, and absence of delivery content pass.

---

### Task 9: Full Regression, Responsive E2E, and Production Deployment

**Files:**
- Modify: `frontend/e2e/console.spec.ts`
- Modify: `README.md`
- Modify: `config/groups.example.yaml`
- Modify: `docker-compose.yml` only if production compatibility requires it.

- [ ] **Step 1: Write E2E scenarios before final implementation verification**

Cover these flows at `1440×900`, `768×1024`, and `390×844`:

```ts
test("public home is keyless and filters sources immediately", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Telegram 频道资讯监测平台" })).toBeVisible();
  await expect(page.getByLabel("管理密钥")).toHaveCount(0);
  await page.getByRole("radio", { name: /竹新社/ }).click();
  await expect(page).toHaveURL(/chat_id=/);
});

test("admin route requires the management key", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByLabel("管理密钥")).toBeVisible();
});
```

Add screenshot/DOM assertions that public images have `object-fit: contain`, the page has no horizontal overflow, and Escape closes the viewer.

- [ ] **Step 2: Run the entire local verification matrix**

```bash
.venv/bin/python -m unittest discover -s tests -v
cd frontend && npm run test
npm run build
npm run test:e2e
cd .. && APP_UID=1000 APP_GID=1000 docker compose config --quiet
```

Expected: all backend, frontend, build, E2E, and Compose commands exit `0`; public JS remains within the existing 250KB raw budget.

- [ ] **Step 3: Back up production data before deployment**

Create a timestamped directory under `/opt/backups/telegram-forwarder/`, perform an online SQLite backup, archive `data/`, `.env`, `config/groups.yaml`, and the current deployment, and record SHA-256 checksums. Do not print secret values.

- [ ] **Step 4: Build before switching containers**

Upload a release archive that excludes `.env`, `data`, local virtual environments, `node_modules`, build output, and macOS AppleDouble/xattrs. Extract code while preserving production runtime data, then run `docker-compose build telegram-forwarder` with the old container still serving traffic.

- [ ] **Step 5: Recreate and verify the production container**

After a successful build, tag the old image for rollback and run `docker-compose up -d`. Verify:

```text
GET /health                                  -> 200
GET /                                        -> 200 and no key gate
GET /api/public/sources                      -> 200 without cookie
GET /api/admin/sources                       -> 401 without cookie
GET /docs                                    -> 404
POST cross-origin admin mutation             -> 403
Docker user                                  -> app / uid 1000
Host listener                                -> 127.0.0.1:8000 only
UFW 8000 rule count                          -> 0
Scheduler jobs                               -> crawl_public_sources only
Public source health                         -> healthy after first run
```

- [ ] **Step 6: Verify production UI and rollback readiness**

Exercise public source switching and `/admin` login over HTTPS, verify complete images and responsive layouts, confirm no enterprise-WeChat text or delivery jobs exist, and record the backup path and previous image tag. If any mandatory check fails, restore the prior deployment and SQLite backup instead of leaving a partial release.
