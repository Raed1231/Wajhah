"""Reloadable, source-labelled service information, separate from routing KB.

Invalid edits affect this read-only endpoint only. No network fetch or AI call
occurs here, and document-only observations never become official by default.
"""
from datetime import date
import json
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter
from pydantic import Field, ValidationError, field_validator, model_validator

from contracts import StrictModel
from kb_routing import CHANNELS, SERVICES, validate_service
from service_errors import ServiceError

router = APIRouter()
DATA_PATH = Path(__file__).with_name('service_information.json')
MAX_DATA_BYTES = 2 * 1024 * 1024
GROUPS = ('prerequisites', 'steps', 'information', 'documents', 'eligibility', 'channels', 'drafting_guidance')
Status = Literal['Verified', 'Unverified', 'Conflicting', 'Missing']
Language = Literal['ar', 'en']
Requirement = Literal['MANDATORY', 'OPTIONAL', 'CONDITIONAL', 'UNKNOWN', 'NOT_APPLICABLE']
Identifier = Annotated[str, Field(min_length=1, max_length=160)]
ShortText = Annotated[str, Field(min_length=1, max_length=500)]
Description = Annotated[str, Field(max_length=8000)]

# Official host allowlist, including documented KB channels.
_OFFICIAL_ROOTS = frozenset({
    'moe.gov.sa', 'moh.gov.sa', 'hrsd.gov.sa', 'investsaudi.sa',
    'misa.gov.sa', 'gmedia.gov.sa', 'media.gov.sa', 'my.gov.sa',
} | {urlsplit(item['url']).hostname for item in CHANNELS.values()
     if item.get('official_status') == 'REPORTED_OFFICIAL' and item.get('usage_status') == 'DOCUMENTED'
     and isinstance(item.get('url'), str) and urlsplit(item['url']).hostname})


def official_url(value):
    if not isinstance(value, str) or not value or len(value) > 2048 or '\\' in value or any(ord(char) <= 32 or ord(char) == 127 for char in value):
        raise ValueError('Invalid official URL')
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        if (parsed.scheme != 'https' or not host or parsed.username or parsed.password
                or parsed.port not in (None, 443)
                or not any(host == root or host.endswith('.' + root) for root in _OFFICIAL_ROOTS)):
            raise ValueError()
    except ValueError:
        raise ValueError('Invalid official URL') from None
    return value


class Source(StrictModel):
    id: Identifier
    url: str = Field(max_length=2048)
    title: ShortText
    accessed_at: str | None
    verification_status: Status
    evidence_basis: str = Field(min_length=1, max_length=1000)

    _official_url = field_validator('url')(official_url)

    @field_validator('accessed_at')
    @classmethod
    def valid_date(cls, value):
        if value is not None:
            date.fromisoformat(value)
        return value


class InformationItem(StrictModel):
    id: Identifier
    title_ar: ShortText
    title_en: ShortText
    description_ar: Description
    description_en: Description
    verification_status: Status
    requirement_status: Requirement
    source_ids: list[Identifier] = Field(max_length=30)
    conditions_ar: str = Field(default='', max_length=3000)
    conditions_en: str = Field(default='', max_length=3000)
    scope_ar: str = Field(default='', max_length=3000)
    scope_en: str = Field(default='', max_length=3000)
    order: int | None = Field(default=None, ge=1, le=1000)
    kind: str | None = Field(default=None, max_length=100)
    url: str | None = Field(default=None, max_length=2048)
    channel_ids: list[Identifier] = Field(default_factory=list, max_length=30)

    @field_validator('url')
    @classmethod
    def safe_optional_url(cls, value):
        return official_url(value) if value is not None else None


class Gap(StrictModel):
    id: Identifier
    title_ar: ShortText
    title_en: ShortText
    reason_ar: Description
    reason_en: Description


class SubmissionSupport(StrictModel):
    verification_status: Status
    status: str = Field(min_length=1, max_length=100)
    source_ids: list[Identifier] = Field(max_length=30)


class ServiceInformation(StrictModel):
    service_id: Identifier
    authority_id: Identifier
    prerequisites: list[InformationItem] = Field(default_factory=list, max_length=150)
    steps: list[InformationItem] = Field(default_factory=list, max_length=150)
    information: list[InformationItem] = Field(default_factory=list, max_length=150)
    documents: list[InformationItem] = Field(default_factory=list, max_length=150)
    eligibility: list[InformationItem] = Field(default_factory=list, max_length=150)
    channels: list[InformationItem] = Field(default_factory=list, max_length=150)
    drafting_guidance: list[InformationItem] = Field(default_factory=list, max_length=150)
    ai_submission_support: SubmissionSupport
    gaps: list[Gap] = Field(default_factory=list, max_length=100)


class ServiceInformationData(StrictModel):
    schema_version: Literal['1.0.0']
    dataset_id: Literal['wajhah.service_information']
    reviewed_at: str
    sources: list[Source] = Field(max_length=300)
    services: list[ServiceInformation] = Field(max_length=30)

    @field_validator('reviewed_at')
    @classmethod
    def valid_date(cls, value):
        date.fromisoformat(value)
        return value

    @model_validator(mode='after')
    def coherent_sources_and_services(self):
        source_index = {source.id: source for source in self.sources}
        if len(source_index) != len(self.sources):
            raise ValueError('Duplicate source')
        identifiers = [service.service_id for service in self.services]
        if len(identifiers) != len(set(identifiers)) or set(identifiers) != set(SERVICES):
            raise ValueError('Service information must cover the known services')
        seen_items = set()
        for stored in self.services:
            service, _, _ = validate_service(stored.service_id)
            if stored.authority_id != service['authority_id']:
                raise ValueError('Wrong authority')
            verified_channels = {item.id for item in stored.channels if item.verification_status == 'Verified'}
            for group in GROUPS:
                items = getattr(stored, group)
                for item in items:
                    if item.id in seen_items:
                        raise ValueError('Duplicate information item')
                    seen_items.add(item.id)
                    if len(item.source_ids) != len(set(item.source_ids)) or any(identifier not in source_index for identifier in item.source_ids):
                        raise ValueError('Unknown information source')
                    if item.verification_status == 'Verified' and (not item.source_ids or any(source_index[identifier].verification_status != 'Verified' for identifier in item.source_ids)):
                        raise ValueError('Verified information needs verified sources')
                    if item.channel_ids and (group not in ('prerequisites', 'steps')
                            or len(item.channel_ids) != len(set(item.channel_ids))
                            or not set(item.channel_ids) <= verified_channels):
                        raise ValueError('Invalid guidance channel association')
            support = stored.ai_submission_support
            if any(identifier not in source_index for identifier in support.source_ids):
                raise ValueError('Unknown support source')
            if support.verification_status == 'Verified' and (not support.source_ids or any(source_index[identifier].verification_status != 'Verified' for identifier in support.source_ids)):
                raise ValueError('Verified support needs verified sources')
        return self


def load_information():
    # Reload per request so guidance edits need no frontend build or restart.
    # Validate the full dataset before exposing any records.
    try:
        with DATA_PATH.open('rb') as stream:
            raw = stream.read(MAX_DATA_BYTES + 1)
        if len(raw) > MAX_DATA_BYTES:
            raise ValueError()
        return ServiceInformationData.model_validate_json(raw)
    except (OSError, ValueError, TypeError, ValidationError, RecursionError):
        raise ServiceError('SERVICE_INFORMATION_UNAVAILABLE', 503,
                           'معلومات الخدمة غير متاحة مؤقتًا. حاول لاحقًا.', True) from None


def localized_item(item, language):
    result = {
        'id': item.id, 'title': getattr(item, 'title_' + language),
        'description': getattr(item, 'description_' + language),
        'verification_status': item.verification_status,
        'requirement_status': item.requirement_status,
        'conditions': getattr(item, 'conditions_' + language),
        'scope': getattr(item, 'scope_' + language), 'order': item.order,
        'source_ids': item.source_ids,
    }
    if item.url is not None:
        result['url'] = item.url
    if item.kind is not None:
        result['kind'] = item.kind
    if item.channel_ids:
        result['channel_ids'] = item.channel_ids
    return result


def verified_conversation_facts(service_id, language, baseline):
    """Adapt current verified records to existing follow-up answer purposes.

    The routing prompt/guard and planner vocabulary do not change. Missing or
    malformed sidecar data leaves Sprint 1 follow-ups available unchanged.
    """
    try:
        dataset = load_information()
        stored = next(service for service in dataset.services if service.service_id == service_id)
    except (ServiceError, StopIteration):
        return baseline
    source_index = {source.id: source for source in dataset.sources}
    ar = language == 'ar'
    budget = 12000
    result = dict(baseline)

    def adapt(items, prefix, *, label_requirement=True):
        nonlocal budget
        items = sorted([item for item in items if item.verification_status == 'Verified'],
                       key=lambda item: (item.order is None, item.order or 0))
        if not items or len(items) > 30:
            return None
        requirement_labels = {
            'MANDATORY': 'إلزامي ضمن النطاق المذكور' if ar else 'Mandatory within the stated scope',
            'OPTIONAL': 'اختياري' if ar else 'Optional',
            'CONDITIONAL': 'مشروط بالحالة المذكورة' if ar else 'Conditional on the stated case',
            'UNKNOWN': 'الإلزام غير محسوم' if ar else 'Mandatory status is not established',
            'NOT_APPLICABLE': 'لا ينطبق' if ar else 'Not applicable',
        }
        lines, identifiers = [], set()
        scope_label = 'النطاق: ' if ar else 'Scope: '
        scopes = {getattr(item, 'scope_' + language) for item in items}
        for item in items:
            title = getattr(item, 'title_' + language)
            description = getattr(item, 'description_' + language)
            condition = getattr(item, 'conditions_' + language)
            scope = getattr(item, 'scope_' + language)
            text = title + (': ' + description if description else '')
            if label_requirement:
                text += ' (' + requirement_labels[item.requirement_status] + ')'
            if condition:
                text += ('؛ الشرط: ' if ar else '; condition: ') + condition
            if scope and len(scopes) > 1:
                text += ' — ' + scope_label + scope
            lines.append('• ' + text)
            identifiers.update(item.source_ids)
        source_lines = [source_index[identifier].title + ' — ' + source_index[identifier].url
                        for identifier in sorted(identifiers)]
        text = prefix + '\n' + '\n'.join(lines)
        if len(scopes) == 1 and (scope := next(iter(scopes))):
            text += '\n' + scope_label + scope
        text += ('\nالمصادر: ' if ar else '\nSources: ') + '\n'.join(source_lines)
        # Never truncate conditions or scope to fit the prompt.
        if len(text) > budget:
            return None
        budget -= len(text)
        return text

    steps = adapt(stored.steps, 'هذه الخطوات المنشورة المسجلة، ضمن النطاق التالي؛ لا تثبت كل صفحات البوابة أو جميع الحالات:' if ar else
                  'These are the recorded published steps within the following scope; they do not establish every portal page or every case:', label_requirement=False)
    if steps:
        result['exact_steps'] = steps
    documents = adapt(stored.documents, 'المعلومات المتحققة عن المرفقات، دون افتراض قائمة مستندات شاملة:' if ar else
                      'Verified recorded attachment information, without assuming a complete document list:')
    if documents:
        result['documents'] = documents
    login_items = [item for item in stored.prerequisites if any(word in (item.title_ar + ' ' + item.description_ar + ' ' + item.title_en + ' ' + item.description_en).lower()
                   for word in ('تسجيل الدخول', 'حساب', 'نفاذ', 'login', 'sign-in', 'account', 'nafath'))]
    prerequisites = adapt([item for item in stored.prerequisites if item not in login_items],
                          'المتطلبات المسبقة المنشورة ضمن المسار المسجل:' if ar else
                          'Published prerequisites within the recorded path:')
    information = adapt(stored.information, 'المعلومات المطلوبة المنشورة ضمن المسار المسجل:' if ar else
                        'Published requested information within the recorded path:')
    if prerequisites or information:
        previous = baseline.get('preparation')
        earlier = (('معلومات المسار السابقة بحدود توثيقها:\n' if ar else 'Earlier path information within its recorded limits:\n') + previous) if previous else None
        result['preparation'] = '\n\n'.join(section for section in (earlier, prerequisites, information) if section)
    login = adapt(login_items, 'معلومات الدخول المنشورة، ضمن نطاقها المسجل:' if ar else
                  'Published sign-in information within its recorded scope:')
    if login:
        result['login'] = login
        result['login_method'] = login + ('\nلا يثبت ذلك استخدام نفاذ تحديدًا ما لم يذكره المصدر صراحة.' if ar else
                                         '\nThis does not establish Nafath specifically unless the source explicitly says so.')
    eligibility = adapt(stored.eligibility, 'شروط الأهلية المنشورة ضمن نطاقها المسجل:' if ar else
                        'Published eligibility information within its recorded scope:')
    if eligibility:
        result['eligibility'] = eligibility
    return result


@router.get('/services/{service_id}/guidance')
async def service_guidance(service_id: str, language: Language = 'ar'):
    try:
        service, authority, _ = validate_service(service_id)
    except ValueError:
        raise ServiceError('SERVICE_NOT_FOUND', 404, 'الخدمة غير موجودة ضمن التغطية المتاحة.') from None
    dataset = load_information()
    stored = next(item for item in dataset.services if item.service_id == service_id)
    result = {
        'service_id': service_id,
        'service_name': service.get('name_' + language) or service['name_ar'],
        'authority': authority.get('name_' + language) or authority['name_ar'],
        'service_scope': service.get('scope_description'),
        'service_scope_language': 'ar',
        'language': language, 'reviewed_at': dataset.reviewed_at,
        'unverified_items': {},
        'verification_counts': {key: 0 for key in ('Verified', 'Unverified', 'Conflicting', 'Missing')},
    }
    used_sources = set(stored.ai_submission_support.source_ids)
    for group in GROUPS:
        result[group], result['unverified_items'][group] = [], []
        for item in sorted(getattr(stored, group), key=lambda value: (value.order is None, value.order or 0)):
            result['verification_counts'][item.verification_status] += 1
            used_sources.update(item.source_ids)
            target = result[group] if item.verification_status == 'Verified' else result['unverified_items'][group]
            target.append(localized_item(item, language))
    result['gaps'] = [{'id': gap.id, 'title': getattr(gap, 'title_' + language),
                       'reason': getattr(gap, 'reason_' + language)} for gap in stored.gaps]
    result['ai_submission_support'] = stored.ai_submission_support.model_dump()
    result['sources'] = [source.model_dump() for source in dataset.sources if source.id in used_sources]
    return result
