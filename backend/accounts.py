import asyncio
import hashlib
import hmac
import os
import re
import secrets
import smtplib
import time
from email.message import EmailMessage
from typing import Literal

from fastapi import APIRouter, Header
from pymongo import AsyncMongoClient
from pymongo.errors import DuplicateKeyError

from contracts import StrictModel
from observability import logger
from service_errors import ServiceError

router = APIRouter()

USER_TYPES = ('citizen', 'resident', 'visitor', 'pilgrim')
NAME_PATTERN = re.compile(r"[^\W\d_]+(?:[ '\-][^\W\d_]+)*")
EMAIL_PATTERN = re.compile(r'[^@\s]{1,64}@[^@\s.]+(?:\.[^@\s.]+)*\.[A-Za-z]{2,}')
LOCAL_PHONE = re.compile(r'05\d{8}')
INTERNATIONAL_PHONE = re.compile(r'\+[1-9]\d{7,14}')
CODE_SECONDS = 10 * 60
RESEND_SECONDS = 60
MAX_CODE_ATTEMPTS = 5
SESSION_SECONDS = 7 * 24 * 60 * 60

_client = None
_db = None
_indexed = False


class FieldsError(ServiceError):
    def __init__(self, code, status, message, fields):
        super().__init__(code, status, message)
        self.fields = fields

    def detail(self, request_id):
        return {**super().detail(request_id), 'fields': self.fields}


class RegisterRequest(StrictModel):
    name: str
    email: str
    phone: str
    password: str
    user_type: str
    language: Literal['ar', 'en'] = 'ar'


class VerifyRequest(StrictModel):
    email: str
    code: str


class ResendRequest(StrictModel):
    email: str
    language: Literal['ar', 'en'] = 'ar'


class LoginRequest(StrictModel):
    email: str
    password: str


class ProfileUpdate(StrictModel):
    name: str | None = None
    phone: str | None = None
    user_type: str | None = None


class DeleteRequest(StrictModel):
    password: str


def use_database(db):
    global _db, _indexed
    _db, _indexed = db, False


async def database():
    global _client, _db, _indexed
    if _db is None:
        _client = AsyncMongoClient(os.getenv('MONGODB_URI', 'mongodb://127.0.0.1:27017'), serverSelectionTimeoutMS=5000)
        _db = _client[os.getenv('MONGODB_DB', 'wajhah')]
    if not _indexed:
        await _db.users.create_index('email', unique=True)
        await _db.users.create_index('phone', unique=True)
        await _db.sessions.create_index('token_hash', unique=True)
        _indexed = True
    return _db


async def close_database():
    global _client, _db, _indexed
    if _client is not None:
        await _client.close()
    _client, _db, _indexed = None, None, False


def normalize_email(email):
    return email.strip().lower()


def normalize_phone(phone):
    phone = re.sub(r'[\s\-()]', '', phone)
    if LOCAL_PHONE.fullmatch(phone):
        return '+966' + phone[1:]
    if INTERNATIONAL_PHONE.fullmatch(phone):
        return phone
    return None


def name_error(name):
    name = ' '.join(name.split())
    return None if 2 <= len(name) <= 100 and NAME_PATTERN.fullmatch(name) else 'INVALID_NAME'


def email_error(email):
    email = normalize_email(email)
    return None if len(email) <= 254 and EMAIL_PATTERN.fullmatch(email) else 'INVALID_EMAIL'


def password_error(password):
    valid = 8 <= len(password) <= 128 and re.search(r'[^\W\d_]', password) and re.search(r'\d', password)
    return None if valid else 'WEAK_PASSWORD'


def check_profile(name=None, phone=None, user_type=None):
    errors = {}
    if name is not None and name_error(name):
        errors['name'] = 'INVALID_NAME'
    if phone is not None and normalize_phone(phone) is None:
        errors['phone'] = 'INVALID_PHONE'
    if user_type is not None and user_type not in USER_TYPES:
        errors['user_type'] = 'INVALID_USER_TYPE'
    return errors


def invalid_details(errors):
    return FieldsError('INVALID_DETAILS', 422, 'راجع البيانات المدخلة.', errors)


def duplicate(field):
    code = 'EMAIL_TAKEN' if field == 'email' else 'PHONE_TAKEN'
    return FieldsError('ACCOUNT_EXISTS', 409, 'يوجد حساب مسجل بهذه البيانات.', {field: code})


def duplicate_field(error):
    keys = (error.details or {}).get('keyPattern') or {}
    return 'phone' if 'phone' in keys or 'phone' in str(error) else 'email'


def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1)
    return f'scrypt${salt.hex()}${digest.hex()}'


def password_matches(password, stored):
    _, salt, digest = stored.split('$')
    candidate = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=2 ** 14, r=8, p=1)
    return hmac.compare_digest(candidate.hex(), digest)


def code_hash(email, code):
    return hashlib.sha256(f'{email}:{code}'.encode()).hexdigest()


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def public_user(user):
    return {'name': user['name'], 'email': user['email'], 'phone': user['phone'],
            'user_type': user['user_type'], 'verified': user['verified'], 'created_at': user['created_at']}


def send_code(email, code, language):
    host = os.getenv('SMTP_HOST')
    if not host:
        logger.warning('dev_verification_code code=%s', code)
        return
    message = EmailMessage()
    message['From'] = os.getenv('SMTP_FROM') or os.getenv('SMTP_USER')
    message['To'] = email
    if language == 'en':
        message['Subject'] = 'Wajhah verification code'
        message.set_content(f'Your Wajhah verification code is {code}. It expires in 10 minutes.')
    else:
        message['Subject'] = 'رمز التحقق من وجهة'
        message.set_content(f'رمز التحقق الخاص بك في وجهة هو {code}. صالح لمدة 10 دقائق.')
    with smtplib.SMTP(host, int(os.getenv('SMTP_PORT', '587')), timeout=15) as smtp:
        smtp.starttls()
        if os.getenv('SMTP_USER'):
            smtp.login(os.getenv('SMTP_USER'), os.getenv('SMTP_PASSWORD', ''))
        smtp.send_message(message)


async def issue_code(db, user, language):
    code = f'{secrets.randbelow(10 ** 6):06d}'
    now = int(time.time())
    await db.users.update_one({'_id': user['_id']}, {'$set': {
        'code_hash': code_hash(user['email'], code), 'code_expires_at': now + CODE_SECONDS,
        'code_sent_at': now, 'code_attempts': 0,
    }})
    try:
        await asyncio.to_thread(send_code, user['email'], code, language)
        return True
    except (OSError, smtplib.SMTPException):
        logger.warning('verification_email_failed')
        return False


async def current_user(authorization):
    if not authorization or not authorization.startswith('Bearer '):
        raise ServiceError('NOT_SIGNED_IN', 401, 'سجّل الدخول للمتابعة.')
    db = await database()
    session = await db.sessions.find_one({'token_hash': token_hash(authorization[7:]), 'expires_at': {'$gt': int(time.time())}})
    user = session and await db.users.find_one({'_id': session['user_id']})
    if not user:
        raise ServiceError('NOT_SIGNED_IN', 401, 'انتهت الجلسة. سجّل الدخول مجددًا.')
    return db, user, session


@router.post('/auth/register', status_code=201)
async def register(request: RegisterRequest):
    errors = check_profile(request.name, request.phone, request.user_type)
    if email_error(request.email):
        errors['email'] = 'INVALID_EMAIL'
    if password_error(request.password):
        errors['password'] = 'WEAK_PASSWORD'
    if errors:
        raise invalid_details(errors)
    db = await database()
    email, phone = normalize_email(request.email), normalize_phone(request.phone)
    for field, value in (('email', email), ('phone', phone)):
        if await db.users.find_one({field: value}):
            raise duplicate(field)
    user = {
        'name': ' '.join(request.name.split()), 'email': email, 'phone': phone, 'user_type': request.user_type,
        'password_hash': await asyncio.to_thread(hash_password, request.password),
        'verified': False, 'created_at': int(time.time()),
    }
    try:
        user['_id'] = (await db.users.insert_one(user)).inserted_id
    except DuplicateKeyError as error:
        raise duplicate(duplicate_field(error)) from None
    sent = await issue_code(db, user, request.language)
    return {'email': email, 'code_sent': sent}


@router.post('/auth/verify')
async def verify(request: VerifyRequest):
    db = await database()
    email = normalize_email(request.email)
    user = await db.users.find_one({'email': email})
    if user and user['verified']:
        raise ServiceError('ALREADY_VERIFIED', 409, 'الحساب مفعّل مسبقًا. يمكنك تسجيل الدخول.')
    if not user or not user.get('code_hash'):
        raise ServiceError('INVALID_CODE', 400, 'رمز التحقق غير صحيح.')
    if user['code_attempts'] >= MAX_CODE_ATTEMPTS:
        raise ServiceError('TOO_MANY_ATTEMPTS', 429, 'تجاوزت عدد المحاولات. اطلب رمزًا جديدًا.')
    if user['code_expires_at'] <= int(time.time()):
        raise ServiceError('CODE_EXPIRED', 400, 'انتهت صلاحية الرمز. اطلب رمزًا جديدًا.')
    if not hmac.compare_digest(user['code_hash'], code_hash(email, request.code.strip())):
        await db.users.update_one({'_id': user['_id']}, {'$inc': {'code_attempts': 1}})
        raise ServiceError('INVALID_CODE', 400, 'رمز التحقق غير صحيح.')
    await db.users.update_one({'_id': user['_id']}, {
        '$set': {'verified': True},
        '$unset': {'code_hash': '', 'code_expires_at': '', 'code_sent_at': '', 'code_attempts': ''},
    })
    return {'verified': True}


@router.post('/auth/resend-code')
async def resend_code(request: ResendRequest):
    db = await database()
    user = await db.users.find_one({'email': normalize_email(request.email)})
    if not user or user['verified']:
        return {'code_sent': True}
    if int(time.time()) - user.get('code_sent_at', 0) < RESEND_SECONDS:
        raise ServiceError('CODE_COOLDOWN', 429, 'انتظر دقيقة قبل طلب رمز جديد.')
    return {'code_sent': await issue_code(db, user, request.language)}


@router.post('/auth/login')
async def login(request: LoginRequest):
    db = await database()
    user = await db.users.find_one({'email': normalize_email(request.email)})
    if not user or not await asyncio.to_thread(password_matches, request.password, user['password_hash']):
        raise ServiceError('INVALID_CREDENTIALS', 401, 'البريد الإلكتروني أو كلمة المرور غير صحيحة.')
    if not user['verified']:
        raise ServiceError('ACCOUNT_NOT_VERIFIED', 403, 'فعّل حسابك برمز التحقق قبل تسجيل الدخول.')
    token = secrets.token_urlsafe(32)
    await db.sessions.insert_one({'token_hash': token_hash(token), 'user_id': user['_id'],
                                  'expires_at': int(time.time()) + SESSION_SECONDS})
    return {'token': token, 'user': public_user(user)}


@router.post('/auth/logout')
async def logout(authorization: str | None = Header(default=None)):
    db, _, session = await current_user(authorization)
    await db.sessions.delete_one({'_id': session['_id']})
    return {'signed_out': True}


@router.get('/profile')
async def get_profile(authorization: str | None = Header(default=None)):
    _, user, _ = await current_user(authorization)
    return public_user(user)


@router.patch('/profile')
async def update_profile(request: ProfileUpdate, authorization: str | None = Header(default=None)):
    db, user, _ = await current_user(authorization)
    errors = check_profile(request.name, request.phone, request.user_type)
    if errors:
        raise invalid_details(errors)
    changes = {}
    if request.name is not None:
        changes['name'] = ' '.join(request.name.split())
    if request.phone is not None:
        changes['phone'] = normalize_phone(request.phone)
        if await db.users.find_one({'phone': changes['phone'], '_id': {'$ne': user['_id']}}):
            raise duplicate('phone')
    if request.user_type is not None:
        changes['user_type'] = request.user_type
    if changes:
        try:
            await db.users.update_one({'_id': user['_id']}, {'$set': changes})
        except DuplicateKeyError:
            raise duplicate('phone') from None
    return public_user({**user, **changes})


@router.delete('/profile')
async def delete_account(request: DeleteRequest, authorization: str | None = Header(default=None)):
    db, user, _ = await current_user(authorization)
    if not await asyncio.to_thread(password_matches, request.password, user['password_hash']):
        raise FieldsError('INVALID_CREDENTIALS', 401, 'كلمة المرور غير صحيحة.', {'password': 'WRONG_PASSWORD'})
    await db.sessions.delete_many({'user_id': user['_id']})
    await db.users.delete_one({'_id': user['_id']})
    return {'deleted': True}
