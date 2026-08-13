from __future__ import annotations

import io
import json
import re
import shutil
import textwrap
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, List, Optional
from urllib import error, request
from zoneinfo import ZoneInfo


FONT_CANDIDATES = (
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
)


@dataclass(frozen=True)
class ImageExportResult:
    paths: List[str]


@dataclass
class MessageCard:
    index: int
    time_label: str
    sender: str
    lines: List[str]
    image: Optional[Any]
    card_height: int


class SummaryImageExporter:
    def __init__(
        self,
        output_dir: str,
        *,
        width: int = 1080,
        max_height: int = 1800,
        font_size: int = 30,
    ) -> None:
        self.output_dir = Path(output_dir)
        self.width = int(width)
        self.max_height = int(max_height)
        self.font_size = int(font_size)

    def export(
        self,
        *,
        group_name: str,
        chat_id: int,
        summary: str,
        messages: Optional[List[object]] = None,
        timezone_name: str = "UTC",
    ) -> ImageExportResult:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        safe_name = safe_filename(group_name or str(chat_id))
        paths: List[str] = []

        if messages:
            ordered_messages = sort_messages_newest_first(messages)
            pages = paginate_message_cards(
                build_message_cards(
                    ordered_messages,
                    width=self.width,
                    font_size=self.font_size,
                    timezone_name=timezone_name,
                ),
                max_height=self.max_height,
            )
            for index, page in enumerate(pages, start=1):
                filename = f"{timestamp}_{safe_name}_{chat_id}_part{index:02d}.png"
                path = self.output_dir / filename
                render_card_page(
                    path=path,
                    group_name=group_name,
                    chat_id=chat_id,
                    cards=page,
                    page_number=index,
                    total_pages=len(pages),
                    total_messages=len(ordered_messages),
                    width=self.width,
                    font_size=self.font_size,
                )
                paths.append(str(path))
            if paths:
                latest_path = self.output_dir / f"latest_{safe_name}_{chat_id}.png"
                shutil.copyfile(paths[0], latest_path)
                paths.insert(0, str(latest_path))
            return ImageExportResult(paths=paths)

        pages = paginate_render_text(
            clean_render_text(summary),
            width=self.width,
            max_height=self.max_height,
            font_size=self.font_size,
        )
        for index, page in enumerate(pages, start=1):
            filename = f"{timestamp}_{safe_name}_{chat_id}_part{index:02d}.png"
            path = self.output_dir / filename
            render_text_png(
                page,
                path,
                width=self.width,
                max_height=self.max_height,
                font_size=self.font_size,
            )
            paths.append(str(path))
        return ImageExportResult(paths=paths)


def build_message_cards(
    messages: List[object],
    *,
    width: int,
    font_size: int,
    timezone_name: str,
) -> List[MessageCard]:
    from PIL import Image, ImageDraw

    body_font = load_font(font_size)
    content_width = width - 96 - 56
    draw_probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    local_tz = get_timezone(timezone_name)
    cards: List[MessageCard] = []

    for index, message in enumerate(messages, start=1):
        image = load_message_image(message, max_width=content_width, max_height=520)
        text = display_message_content(message, has_image=image is not None)
        lines = wrap_lines(clean_render_text(text), draw_probe, body_font, content_width)
        if not lines and image is None:
            lines = ["[无文本内容]"]

        line_height = font_size + 12
        image_height = image.height + 16 if image is not None else 0
        text_height = len(lines) * line_height if lines else 0
        card_height = 30 + 38 + image_height + text_height + 30
        if image is not None and lines:
            card_height += 10

        cards.append(
            MessageCard(
                index=index,
                time_label=format_message_time(getattr(message, "message_time", ""), local_tz),
                sender=str(getattr(message, "sender_name", "") or "Unknown"),
                lines=lines,
                image=image,
                card_height=card_height,
            )
        )
    return cards


def paginate_message_cards(cards: List[MessageCard], *, max_height: int) -> List[List[MessageCard]]:
    page_top = 180
    page_bottom = 48
    gap = 22
    pages: List[List[MessageCard]] = []
    current: List[MessageCard] = []
    current_height = page_top + page_bottom

    for card in cards:
        addition = card.card_height + (gap if current else 0)
        if current and current_height + addition > max_height:
            pages.append(current)
            current = [card]
            current_height = page_top + page_bottom + card.card_height
        else:
            current.append(card)
            current_height += addition

    if current:
        pages.append(current)
    return pages or [[]]


def render_card_page(
    *,
    path: Path,
    group_name: str,
    chat_id: int,
    cards: List[MessageCard],
    page_number: int,
    total_pages: int,
    total_messages: int,
    width: int,
    font_size: int,
) -> None:
    from PIL import Image, ImageDraw

    page_margin = 36
    card_padding = 28
    card_gap = 22
    background = (241, 245, 249)
    panel = (255, 255, 255)
    border = (226, 232, 240)
    title_color = (30, 64, 175)
    muted = (100, 116, 139)
    foreground = (15, 23, 42)
    accent_bg = (219, 234, 254)

    title_font = load_font(38)
    meta_font = load_font(24)
    body_font = load_font(font_size)
    small_font = load_font(22)

    header_height = 150
    height = page_margin + header_height + page_margin
    if cards:
        height += sum(card.card_height for card in cards) + card_gap * (len(cards) - 1)
    else:
        height += 180

    image = Image.new("RGB", (width, height), background)
    draw = ImageDraw.Draw(image)

    draw.rounded_rectangle(
        (page_margin, page_margin, width - page_margin, page_margin + header_height),
        radius=22,
        fill=panel,
        outline=border,
        width=2,
    )
    draw.rounded_rectangle(
        (page_margin, page_margin, width - page_margin, page_margin + 18),
        radius=18,
        fill=(37, 99, 235),
    )
    draw.text((page_margin + 28, page_margin + 34), "Telegram 消息汇总", fill=title_color, font=title_font)
    draw.text(
        (page_margin + 28, page_margin + 90),
        f"{group_name}  |  {total_messages} 条  |  第 {page_number}/{total_pages} 页",
        fill=muted,
        font=meta_font,
    )

    y = page_margin + header_height + page_margin
    if not cards:
        draw.text((page_margin + 28, y), "暂无新消息", fill=foreground, font=body_font)
        image.save(path, "PNG")
        return

    for card in cards:
        x1 = page_margin
        x2 = width - page_margin
        y2 = y + card.card_height
        draw.rounded_rectangle((x1, y, x2, y2), radius=18, fill=panel, outline=border, width=2)
        tag = f"{card.index}. {card.time_label}"
        draw.rounded_rectangle((x1 + card_padding, y + 24, x1 + card_padding + 130, y + 62), radius=12, fill=accent_bg)
        draw.text((x1 + card_padding + 14, y + 29), tag, fill=title_color, font=small_font)
        draw.text((x1 + card_padding + 150, y + 29), card.sender, fill=muted, font=small_font)

        inner_y = y + 78
        if card.image is not None:
            image_x = x1 + card_padding
            draw.rounded_rectangle(
                (image_x - 1, inner_y - 1, image_x + card.image.width + 1, inner_y + card.image.height + 1),
                radius=10,
                outline=border,
                width=2,
            )
            image.paste(card.image, (image_x, inner_y))
            inner_y += card.image.height + 18

        for line in card.lines:
            draw.text((x1 + card_padding, inner_y), line, fill=foreground, font=body_font)
            inner_y += font_size + 12

        y = y2 + card_gap

    image.save(path, "PNG")


def render_text_png(
    text: str,
    path: Path,
    *,
    width: int,
    max_height: int,
    font_size: int,
) -> None:
    from PIL import Image, ImageDraw, ImageFont

    padding = 48
    line_gap = 12
    background = (248, 250, 252)
    foreground = (17, 24, 39)
    accent = (37, 99, 235)
    font = load_font(font_size)
    title_font = load_font(font_size + 6)

    draw_probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    if isinstance(text, list):
        lines = text
    else:
        lines = wrap_lines(text, draw_probe, font, width - padding * 2)
    line_height = font_size + line_gap
    height = max(360, min(max_height, padding * 2 + len(lines) * line_height + 40))

    image = Image.new("RGB", (width, height), background)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((24, 24, width - 24, height - 24), radius=18, fill=(255, 255, 255))

    y = padding
    for index, line in enumerate(lines):
        active_font = title_font if index == 0 else font
        color = accent if index == 0 else foreground
        draw.text((padding, y), line, fill=color, font=active_font)
        y += line_height + (8 if index == 0 else 0)
    image.save(path, "PNG")


def paginate_render_text(
    text: str,
    *,
    width: int,
    max_height: int,
    font_size: int,
) -> List[List[str]]:
    from PIL import Image, ImageDraw

    padding = 48
    line_gap = 12
    font = load_font(font_size)
    draw_probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    lines = wrap_lines(text, draw_probe, font, width - padding * 2)
    max_lines = max(1, (max_height - padding * 2 - 40) // (font_size + line_gap))
    pages: List[List[str]] = []
    current: List[str] = []
    for line in lines:
        if len(current) >= max_lines:
            pages.append(current)
            current = []
        current.append(line)
    if current:
        pages.append(current)
    return pages or [["暂无新消息"]]


def split_summary_pages(summary: str, *, max_chars: int) -> List[str]:
    text = summary.strip()
    if not text:
        return ["暂无新消息"]
    if len(text) <= max_chars:
        return [text]

    pages: List[str] = []
    current = ""
    for block in text.split("\n\n"):
        candidate = block if not current else f"{current}\n\n{block}"
        if len(candidate) > max_chars and current:
            pages.append(current)
            current = block
        else:
            current = candidate
    if current:
        pages.append(current)
    return pages


def sort_messages_newest_first(messages: List[object]) -> List[object]:
    return sorted(
        messages,
        key=lambda message: (
            message_timestamp(getattr(message, "message_time", "")),
            int(getattr(message, "message_id", 0) or 0),
        ),
        reverse=True,
    )


def message_timestamp(value: object) -> float:
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        return 0.0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def wrap_lines(text: str, draw, font, max_width: int) -> List[str]:
    wrapped: List[str] = []
    for raw_line in text.splitlines():
        if raw_line == "":
            wrapped.append("")
            continue
        current = ""
        for token in tokenize_for_wrap(raw_line):
            candidate = current + token
            bbox = draw.textbbox((0, 0), candidate, font=font)
            if bbox[2] - bbox[0] > max_width and current:
                wrapped.append(current.rstrip())
                current = token.lstrip()
            else:
                current = candidate
        if current:
            wrapped.append(current.rstrip())
    return wrapped


def tokenize_for_wrap(line: str) -> List[str]:
    return re.findall(r"[A-Za-z0-9_./:%+#@-]+|\s+|.", line)


def load_font(size: int):
    from PIL import ImageFont

    for font_path in FONT_CANDIDATES:
        if Path(font_path).exists():
            return ImageFont.truetype(font_path, size=size)
    return ImageFont.load_default()


def load_message_image(message: object, *, max_width: int, max_height: int):
    from PIL import Image

    for url in media_urls_from_message(message):
        try:
            http_request = request.Request(
                url,
                headers={"User-Agent": "Mozilla/5.0"},
                method="GET",
            )
            with request.urlopen(http_request, timeout=15) as response:
                data = response.read(8_000_000)
            image = Image.open(io.BytesIO(data)).convert("RGB")
            image.thumbnail((max_width, max_height))
            return image
        except (OSError, error.URLError, TimeoutError, ValueError):
            continue
    return None


def media_urls_from_message(message: object) -> List[str]:
    raw_json = str(getattr(message, "raw_json", "") or "")
    if not raw_json:
        return []
    try:
        raw = json.loads(raw_json)
    except json.JSONDecodeError:
        return []
    media_urls = raw.get("media_urls", [])
    if isinstance(media_urls, str):
        return [media_urls]
    if isinstance(media_urls, list):
        return [str(url) for url in media_urls if isinstance(url, str) and url.startswith("http")]
    return []


def display_message_content(message: object, *, has_image: bool) -> str:
    content = str(getattr(message, "content", "") or "").strip()
    if has_image:
        for prefix in ("[photo] ", "[video] ", "[document] "):
            if content.startswith(prefix):
                return content[len(prefix) :].strip()
        if content in {"[photo]", "[video]", "[document]"}:
            return ""
    return content


def get_timezone(timezone_name: str):
    try:
        return ZoneInfo(timezone_name)
    except Exception:  # noqa: BLE001 - fallback for bad env values.
        return timezone.utc


def format_message_time(value: str, timezone_info) -> str:
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        return "--:--"
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone_info).strftime("%H:%M")


def safe_filename(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("._")
    return normalized or "telegram"


def clean_render_text(value: str) -> str:
    """Remove emoji ranges that common CJK fonts render as empty boxes."""
    return "".join(char for char in value if not is_emoji_or_symbol(char))


def is_emoji_or_symbol(char: str) -> bool:
    codepoint = ord(char)
    category = unicodedata.category(char)
    return (
        category in {"So", "Co", "Cs", "Cf"}
        or 0x1F000 <= codepoint <= 0x1FAFF
        or 0x25A0 <= codepoint <= 0x25FF
        or 0x2600 <= codepoint <= 0x27BF
        or 0x2B00 <= codepoint <= 0x2BFF
        or 0xFE00 <= codepoint <= 0xFE0F
    )
