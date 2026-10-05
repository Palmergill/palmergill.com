"""Gift board (spec 21): a member's people, their gift ideas, and the member's
own wishlist.

Every function here takes the caller's normalized username and filters on it.
That is the privacy boundary for ideas — nothing in this module reads another
account's people or idea rows. The only reads that cross accounts — the
wishlist browser (P2) and a linked contact's wishlist (P4) — go through
``_public_wishlist_query``, which reads only ``person_id IS NULL`` rows with
status ``wanted``.

Someone else's person or item is a 404, never a 403, so ids are not
enumerable.
"""
from datetime import date
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import accounts
from app.services import link_preview
from app.services.link_preview import clean_image_url
from app.database import utc_now
from app.database import AppUser, GIFT_IDEA_STATUSES, GIFT_WISHLIST_STATUSES, GiftItem, GiftPerson

MAX_PEOPLE = 100
MAX_ITEMS = 1000
KEY_STEP = 1000.0
# Below this gap a midpoint stops being distinguishable from its neighbours,
# so the column is respread instead.
MIN_KEY_GAP = 1e-6


def username_for(identity: Dict[str, Any]) -> str:
    username = accounts.normalize_username(str(identity.get("username", "")))
    if not username:
        raise HTTPException(status_code=403, detail="Sign in to use the gift board.")
    return username


# ── validation ──────────────────────────────────────────────────────────────


def clean_text(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    value = value.strip()
    return value or None


def clean_url(value: Optional[str]) -> Optional[str]:
    value = clean_text(value)
    if value is None:
        return None
    parts = urlsplit(value)
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        raise HTTPException(status_code=422, detail="Links must start with http:// or https://.")
    return value


def _clean_image(value: Optional[str]) -> Optional[str]:
    value = clean_text(value)
    if value is None:
        return None
    image = clean_image_url(value)
    if image is None:
        raise HTTPException(status_code=422, detail="Image links must start with https://.")
    return image


def _clean_preview_title(value: Optional[str]) -> Optional[str]:
    value = clean_text(value)
    return value[:200] if value else None


def refresh_preview(
    db: Session, username: str, item_id: int, replace_image: bool, title_from_page: bool
) -> Dict[str, Any]:
    """Look up an item's link and store its preview.

    The image is only replaced when asked, or when the gift has none, so a
    picture the owner pasted by hand survives a background refresh.
    `title_from_page` renames the gift after the page — used when a member
    pasted a bare link as the gift's name.
    """
    item = owned_item(db, username, item_id)
    if not item.url:
        raise HTTPException(status_code=422, detail="This gift has no link to preview.")
    preview = link_preview.find_preview(item.url)
    if preview["title"]:
        item.preview_title = preview["title"]
        if title_from_page:
            item.title = preview["title"]
    if preview["imageUrl"] and (replace_image or not item.image_url):
        item.image_url = preview["imageUrl"]
    item.preview_checked_at = utc_now()
    db.commit()
    db.refresh(item)
    return serialize_item(item)


def side_statuses(person_id: Optional[int]):
    return GIFT_WISHLIST_STATUSES if person_id is None else GIFT_IDEA_STATUSES


def default_status(person_id: Optional[int]) -> str:
    return side_statuses(person_id)[0]


def remap_status(status: str, to_person_id: Optional[int]) -> str:
    """Carry a status across the privacy line when an item changes sides.

    Done-ness survives the move (given ↔ received); everything else resets to
    the destination's starting status.
    """
    if status in side_statuses(to_person_id):
        return status
    if to_person_id is None:
        return "received" if status == "given" else "wanted"
    return "given" if status == "received" else "idea"


# ── lookups ─────────────────────────────────────────────────────────────────


def owned_person(db: Session, username: str, person_id: int) -> GiftPerson:
    person = (
        db.query(GiftPerson)
        .filter(GiftPerson.id == person_id, GiftPerson.owner_username == username)
        .first()
    )
    if person is None:
        raise HTTPException(status_code=404, detail="Person not found.")
    return person


def owned_item(db: Session, username: str, item_id: int) -> GiftItem:
    item = (
        db.query(GiftItem)
        .filter(GiftItem.id == item_id, GiftItem.owner_username == username)
        .first()
    )
    if item is None:
        raise HTTPException(status_code=404, detail="Gift not found.")
    return item


def _people(db: Session, username: str) -> List[GiftPerson]:
    return (
        db.query(GiftPerson)
        .filter(GiftPerson.owner_username == username)
        .order_by(GiftPerson.sort_key, GiftPerson.id)
        .all()
    )


def _column(db: Session, username: str, person_id: Optional[int]) -> List[GiftItem]:
    query = db.query(GiftItem).filter(GiftItem.owner_username == username)
    if person_id is None:
        query = query.filter(GiftItem.person_id.is_(None))
    else:
        query = query.filter(GiftItem.person_id == person_id)
    return query.order_by(GiftItem.sort_key, GiftItem.id).all()


# ── accounts and public wishlists ───────────────────────────────────────────


def _admin_username() -> str:
    return accounts.normalize_username(accounts.admin_username())


def display_names(db: Session, usernames) -> Dict[str, str]:
    """normalized username → display name, for active accounts only.

    The admin has no app_users row, so it is answered from the env var. An
    account missing from the result is unknown or deactivated.
    """
    wanted = {name for name in usernames if name}
    names: Dict[str, str] = {}
    if not wanted:
        return names
    admin = _admin_username()
    if admin in wanted:
        names[admin] = accounts.admin_username()
    rows = (
        db.query(AppUser.username, AppUser.display_name)
        .filter(AppUser.username.in_(wanted), AppUser.is_active.is_(True))
        .all()
    )
    for username, display_name in rows:
        names[username] = display_name or username
    return names


def _public_wishlist_query(db: Session):
    """The only gift rows that may be served to someone other than their owner."""
    return db.query(GiftItem).filter(GiftItem.person_id.is_(None), GiftItem.status == "wanted")


def serialize_public_item(item: GiftItem) -> Dict[str, Any]:
    return {
        "id": item.id,
        "title": item.title,
        "url": item.url,
        "imageUrl": item.image_url,
        "previewTitle": item.preview_title,
        "priceCents": item.price_cents,
        "note": item.note,
    }


def _wishlist_items(db: Session, username: str) -> List[GiftItem]:
    return (
        _public_wishlist_query(db)
        .filter(GiftItem.owner_username == username)
        .order_by(GiftItem.sort_key, GiftItem.id)
        .all()
    )


def wishlists(db: Session, caller: str) -> Dict[str, Any]:
    """Members other than the caller with at least one wanted item."""
    counts = (
        _public_wishlist_query(db)
        .filter(GiftItem.owner_username != caller)
        .with_entities(GiftItem.owner_username, func.count(GiftItem.id))
        .group_by(GiftItem.owner_username)
        .all()
    )
    names = display_names(db, [owner for owner, _count in counts])
    members = [
        {"username": owner, "displayName": names[owner], "count": count}
        for owner, count in counts
        if owner in names
    ]
    members.sort(key=lambda member: member["displayName"].casefold())
    return {"members": members}


def member_wishlist(db: Session, username: str) -> Dict[str, Any]:
    normalized = accounts.normalize_username(username)
    names = display_names(db, [normalized])
    if normalized not in names:
        raise HTTPException(status_code=404, detail="No member by that name.")
    return {
        "username": normalized,
        "displayName": names[normalized],
        "items": [serialize_public_item(item) for item in _wishlist_items(db, normalized)],
    }


# ── ordering ────────────────────────────────────────────────────────────────


def _place(rows: list, moving, index: int) -> None:
    """Give `moving` a sort_key that lands it at `index` among `rows`.

    `rows` is the destination in order and must not contain `moving`. Writes
    one row unless the gap is exhausted, in which case the whole destination
    is respread.
    """
    index = max(0, min(index, len(rows)))
    before = rows[index - 1].sort_key if index > 0 else None
    after = rows[index].sort_key if index < len(rows) else None
    if before is None and after is None:
        moving.sort_key = KEY_STEP
    elif before is None:
        moving.sort_key = after - KEY_STEP
    elif after is None:
        moving.sort_key = before + KEY_STEP
    elif after - before > MIN_KEY_GAP:
        moving.sort_key = (before + after) / 2
    else:
        ordered = rows[:index] + [moving] + rows[index:]
        for position, row in enumerate(ordered, start=1):
            row.sort_key = position * KEY_STEP


# ── serialization ───────────────────────────────────────────────────────────


def _iso(value) -> Optional[str]:
    return value.isoformat() if value else None


def serialize_person(person: GiftPerson, linked: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    data = {
        "id": person.id,
        "name": person.name,
        "note": person.note,
        "birthday": _iso(person.birthday),
        "linkedUsername": person.linked_username,
        "linked": None,
    }
    if person.linked_username and linked is not None:
        data["linked"] = linked.get(person.linked_username)
    return data


def _linked_wishlists(db: Session, people: List[GiftPerson]) -> Dict[str, Dict[str, Any]]:
    """Public wishlists for every linked account on this board, keyed by username.

    A link to an account that has since been deactivated resolves to nothing,
    and the person renders as unlinked rather than erroring.
    """
    usernames = {person.linked_username for person in people if person.linked_username}
    names = display_names(db, usernames)
    return {
        username: {
            "username": username,
            "displayName": names[username],
            "items": [serialize_public_item(item) for item in _wishlist_items(db, username)],
        }
        for username in usernames
        if username in names
    }


def serialize_item(item: GiftItem) -> Dict[str, Any]:
    return {
        "id": item.id,
        "personId": item.person_id,
        "title": item.title,
        "url": item.url,
        "imageUrl": item.image_url,
        "previewTitle": item.preview_title,
        "previewChecked": item.preview_checked_at is not None,
        "priceCents": item.price_cents,
        "note": item.note,
        "status": item.status,
        "occasion": item.occasion,
        "givenOn": _iso(item.given_on),
        "createdAt": _iso(item.created_at),
        "updatedAt": _iso(item.updated_at),
    }


def board(db: Session, username: str) -> Dict[str, Any]:
    items = (
        db.query(GiftItem)
        .filter(GiftItem.owner_username == username)
        .order_by(GiftItem.sort_key, GiftItem.id)
        .all()
    )
    people = _people(db, username)
    linked = _linked_wishlists(db, people)
    return {
        "username": username,
        "people": [serialize_person(person, linked) for person in people],
        "items": [serialize_item(item) for item in items],
        "limits": {"people": MAX_PEOPLE, "items": MAX_ITEMS},
    }


# ── people ──────────────────────────────────────────────────────────────────


def _ensure_unique_name(db: Session, username: str, name: str, exclude_id: Optional[int] = None) -> None:
    query = db.query(GiftPerson.id).filter(
        GiftPerson.owner_username == username,
        func.lower(GiftPerson.name) == name.lower(),
    )
    if exclude_id is not None:
        query = query.filter(GiftPerson.id != exclude_id)
    if query.first():
        raise HTTPException(status_code=409, detail=f"You already have someone called {name}.")


def create_person(
    db: Session, username: str, name: str, note: Optional[str], birthday: Optional[date]
) -> Dict[str, Any]:
    name = clean_text(name)
    if not name:
        raise HTTPException(status_code=422, detail="Give this person a name.")
    people = _people(db, username)
    if len(people) >= MAX_PEOPLE:
        raise HTTPException(status_code=422, detail=f"The board holds up to {MAX_PEOPLE} people.")
    _ensure_unique_name(db, username, name)
    person = GiftPerson(
        owner_username=username, name=name, note=clean_text(note), birthday=birthday, sort_key=0
    )
    _place(people, person, len(people))
    db.add(person)
    db.commit()
    db.refresh(person)
    return serialize_person(person)


def update_person(db: Session, username: str, person_id: int, changes: Dict[str, Any]) -> Dict[str, Any]:
    person = owned_person(db, username, person_id)
    if "name" in changes:
        name = clean_text(changes["name"])
        if not name:
            raise HTTPException(status_code=422, detail="Give this person a name.")
        _ensure_unique_name(db, username, name, exclude_id=person.id)
        person.name = name
    if "note" in changes:
        person.note = clean_text(changes["note"])
    if "birthday" in changes:
        person.birthday = changes["birthday"]
    if "linked_username" in changes:
        person.linked_username = _check_link(db, username, changes["linked_username"])
    db.commit()
    db.refresh(person)
    return serialize_person(person, _linked_wishlists(db, [person]))


def _check_link(db: Session, owner: str, value: Optional[str]) -> Optional[str]:
    target = accounts.normalize_username(value or "")
    if not target:
        return None
    if target == owner:
        raise HTTPException(status_code=422, detail="That's you. Your own wishlist is already on the board.")
    if target not in display_names(db, [target]):
        raise HTTPException(status_code=422, detail="No member by that name.")
    return target


def move_person(db: Session, username: str, person_id: int, index: int) -> Dict[str, Any]:
    person = owned_person(db, username, person_id)
    others = [row for row in _people(db, username) if row.id != person.id]
    _place(others, person, index)
    db.commit()
    return board(db, username)


def delete_person(db: Session, username: str, person_id: int) -> None:
    person = owned_person(db, username, person_id)
    # Explicit rather than trusting ON DELETE CASCADE: SQLite only honours it
    # with PRAGMA foreign_keys on, which this app does not set.
    db.query(GiftItem).filter(
        GiftItem.owner_username == username, GiftItem.person_id == person.id
    ).delete(synchronize_session=False)
    db.delete(person)
    db.commit()


# ── items ───────────────────────────────────────────────────────────────────


def _check_status(status: str, person_id: Optional[int]) -> str:
    allowed = side_statuses(person_id)
    if status not in allowed:
        where = "your wishlist" if person_id is None else "an idea"
        raise HTTPException(
            status_code=422,
            detail=f"Status for {where} must be one of: {', '.join(allowed)}.",
        )
    return status


def create_item(db: Session, username: str, fields: Dict[str, Any]) -> Dict[str, Any]:
    person_id = fields.get("person_id")
    if person_id is not None:
        owned_person(db, username, person_id)
    title = clean_text(fields.get("title"))
    if not title:
        raise HTTPException(status_code=422, detail="Give the gift a name.")
    count = db.query(func.count(GiftItem.id)).filter(GiftItem.owner_username == username).scalar()
    if count >= MAX_ITEMS:
        raise HTTPException(status_code=422, detail=f"The board holds up to {MAX_ITEMS} gifts.")
    status = fields.get("status") or default_status(person_id)
    item = GiftItem(
        owner_username=username,
        person_id=person_id,
        title=title,
        url=clean_url(fields.get("url")),
        image_url=_clean_image(fields.get("image_url")),
        preview_title=_clean_preview_title(fields.get("preview_title")),
        price_cents=fields.get("price_cents"),
        note=clean_text(fields.get("note")),
        status=_check_status(status, person_id),
        occasion=clean_text(fields.get("occasion")),
        given_on=fields.get("given_on"),
        sort_key=0,
    )
    column = _column(db, username, person_id)
    _place(column, item, len(column))
    db.add(item)
    db.commit()
    db.refresh(item)
    return serialize_item(item)


def update_item(db: Session, username: str, item_id: int, changes: Dict[str, Any]) -> Dict[str, Any]:
    item = owned_item(db, username, item_id)
    if "title" in changes:
        title = clean_text(changes["title"])
        if not title:
            raise HTTPException(status_code=422, detail="Give the gift a name.")
        item.title = title
    if "url" in changes:
        url = clean_url(changes["url"])
        if url != item.url:
            # A new link needs a new preview; the old one described a
            # different page.
            item.preview_checked_at = None
            item.preview_title = None
        item.url = url
    if "image_url" in changes:
        item.image_url = _clean_image(changes["image_url"])
    if "preview_title" in changes:
        item.preview_title = _clean_preview_title(changes["preview_title"])
        # The editor sends what its own lookup found, so the gift counts as
        # looked up.
        item.preview_checked_at = utc_now()
    if "price_cents" in changes:
        item.price_cents = changes["price_cents"]
    if "note" in changes:
        item.note = clean_text(changes["note"])
    if "occasion" in changes:
        item.occasion = clean_text(changes["occasion"])
    if "given_on" in changes:
        item.given_on = changes["given_on"]
    if "status" in changes and changes["status"] is not None:
        item.status = _check_status(changes["status"], item.person_id)
    db.commit()
    db.refresh(item)
    return serialize_item(item)


def move_item(
    db: Session, username: str, item_id: int, person_id: Optional[int], index: int
) -> Dict[str, Any]:
    """Reorder an item, or move it to another column.

    Moving between "Me" and a person crosses the privacy line, so the status is
    remapped to the destination side in the same commit. Returns the whole
    board, because an exhausted gap respreads the destination column's keys.
    """
    item = owned_item(db, username, item_id)
    if person_id is not None:
        owned_person(db, username, person_id)
    destination = [row for row in _column(db, username, person_id) if row.id != item.id]
    if item.person_id != person_id:
        item.status = remap_status(item.status, person_id)
        item.person_id = person_id
    _place(destination, item, index)
    db.commit()
    return board(db, username)


def delete_item(db: Session, username: str, item_id: int) -> None:
    item = owned_item(db, username, item_id)
    db.delete(item)
    db.commit()
