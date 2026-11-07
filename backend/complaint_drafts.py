"""Formal draft frames from one user-reviewed account, without model prose.

Updates and attachment extraction require explicit review before composition.
The server does not claim to resolve natural-language contradictions itself.
"""
import hashlib
import hmac
import json
from typing import Annotated, Literal

from fastapi import APIRouter
from pydantic import Field

from contracts import MAX_HISTORY_TOTAL, StrictModel, Text
from conversation import MAX_TOKEN, _open, complaint_parts
from kb_routing import validate_service
from service_errors import ServiceError

router = APIRouter()
MAX_DRAFT_TEXT = 60000


class DraftRequest(StrictModel):
    conversation_token: Annotated[Text, Field(max_length=MAX_TOKEN)]
    language: Literal['ar', 'en'] = 'ar'
    reviewed_facts: Annotated[Text, Field(max_length=MAX_HISTORY_TOTAL)] | None = None
    review_context_id: Annotated[str, Field(min_length=64, max_length=64, pattern=r'^[0-9a-f]{64}$')] | None = None
    facts_confirmed: bool = Field(default=False, strict=True)


def review_context_id(state, language):
    # Bind facts, provenance, route and language, excluding procedural Q&A and turns.
    payload = {
        'original': state.original, 'input_kind': state.input_kind,
        'updates': [update.model_dump() for update in state.updates],
        'route': state.route.model_dump(), 'language': language,
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(raw).hexdigest()


def _review_required():
    return ServiceError('DRAFT_REVIEW_REQUIRED', 409,
                        'راجع الوقائع الحالية وأقرّ النص المحدث قبل إنشاء المسودة.')


def compose_draft(state, language, *, reviewed_facts=None, review_context_id_value=None, facts_confirmed=False):
    service, authority = None, None
    if state.route.status == 'MATCHED':
        try:
            service, authority, _ = validate_service(state.route.service_id)
        except ValueError:
            raise ServiceError('AI_INVALID_ROUTE', 502, 'تعذّر توثيق الخدمة الحالية ضمن قاعدة المعرفة.', True) from None
    complaint, extracted = complaint_parts(state.original, state.input_kind)
    fact_chars = len(state.original) + sum(len(update.text) + len(update.question or '') for update in state.updates)
    if fact_chars > MAX_HISTORY_TOTAL:
        raise ServiceError('DRAFT_CONTEXT_LIMIT', 409, 'سياق الشكوى يتجاوز حد إنشاء المسودة. ابدأ شكوى جديدة مختصرة.')
    context_id = review_context_id(state, language)
    if reviewed_facts is not None:
        if facts_confirmed is not True or review_context_id_value is None or not hmac.compare_digest(context_id, review_context_id_value):
            raise _review_required()
        # Draft only the approved account; source excerpts remain review references.
        account = reviewed_facts
    elif review_context_id_value is not None or facts_confirmed:
        raise _review_required()
    elif state.updates or state.input_kind == 'attachment':
        return {
            'review_required': True, 'context_id': context_id,
            'language': language, 'service_id': service['id'] if service else None,
            'original_text': complaint,
            'updates': [update.model_dump() for update in state.updates],
            'attachment_excerpts': extracted,
            'conversation_turn_count': state.turn_count,
        }
    else:
        account = complaint
    ar = language == 'ar'
    authority_name = (authority.get('name_' + language) or authority['name_ar']) if authority else None
    service_name = (service.get('name_' + language) or service['name_ar']) if service else None
    if ar:
        heading = [f'إلى: {authority_name}', f'الموضوع: شكوى بشأن {service_name}'] if service else ['الموضوع: مسودة شكوى عامة للمراجعة']
        sections = [*heading, 'السلام عليكم ورحمة الله وبركاته،',
                    'أرفع إليكم شكواي للنظر فيها على النحو الآتي:', account]
        sections.extend(['أرجو النظر في الوقائع الموضحة أعلاه وإفادتي بما يلزم وفق اختصاصكم.', 'وتفضلوا بقبول الاحترام.'])
        warnings = ['هذه مسودة قابلة للتحرير ولم تُرسل إلى أي جهة. راجع كل واقعة قبل نسخها أو تقديمها.',
                    'النصوص المنقولة هي أقوال المستخدم وليست إثباتًا مستقلًا. لا تثبت المسودة الأهلية أو المسؤولية القانونية أو نتيجة الشكوى.',
                    'قد تبقى العبارات الأصلية بلغة المستخدم للحفاظ على دقتها.']
        omitted = ['اسم وتوقيع وبيانات تواصل لم يحددها المستخدم في حقول مستقلة', 'تاريخ تحرير تلقائي', 'أدلة أو وقائع أو مطالبات تعويض غير مذكورة']
        if reviewed_facts is not None:
            warnings.append('بُنيت المسودة من نص الوقائع الذي أقررتَه فقط. الإقرار لا يثبت صحته لدى جهة رسمية.')
        if service:
            warnings.append('الجهة مأخوذة من نتيجة التوجيه السابقة ولم تُعد مطابقتها مع النص المحرر. انقل أي تغيير مؤثر إلى المحادثة أولًا، وتحقق من الوجهة قبل الاستخدام.')
        if not service:
            warnings.append('لم تُحدد جهة أو خدمة مدعومة لهذه الشكوى. المسودة عامة ولا تتضمن جهة أو رابطًا مفترضًا؛ تحقق من الوجهة قبل استخدامها.')
            omitted.append('الجهة والخدمة والرابط لعدم وجود مطابقة موثقة')
            if state.route.status == 'NEEDS_CLARIFICATION':
                warnings.append('توجد تفاصيل غير مكتملة لتحديد الوجهة. سؤال الاستيضاح الحالي: ' + state.route.question)
    else:
        heading = [f'To: {authority_name}', f'Subject: Complaint concerning {service_name}'] if service else ['Subject: General complaint draft for review']
        sections = [*heading, 'Dear Sir or Madam,',
                    'I submit this complaint for your consideration as follows:', account]
        sections.extend(['Please review the facts set out above and advise on the appropriate action within your remit.', 'Yours faithfully,'])
        warnings = ['This editable draft has not been sent to any authority. Review every statement before copying or submitting it.',
                    'Quoted statements are the user’s account, not independent proof. This draft does not establish eligibility, legal responsibility or an outcome.',
                    'Original statements may retain the user’s language to preserve their exact meaning.']
        omitted = ['A separately supplied name, signature and contact details', 'An automatically inserted drafting date', 'Unstated evidence, facts or compensation demands']
        if reviewed_facts is not None:
            warnings.append('The draft uses only the facts text you confirmed. Your confirmation is not official verification of its truth.')
        if service:
            warnings.append('The destination comes from the earlier routing result and was not matched again against your edited text. Add material changes to the conversation first, and check the destination before use.')
        if not service:
            warnings.append('No supported authority or service has been identified. This is a general draft with no assumed destination or link; verify where to send it before use.')
            omitted.append('Authority, service and link because there is no documented match')
            if state.route.status == 'NEEDS_CLARIFICATION':
                warnings.append('Some details are still needed to identify the destination. Current clarification question: ' + state.route.question)
    draft = '\n\n'.join(sections)
    if len(draft) > MAX_DRAFT_TEXT:
        raise ServiceError('DRAFT_CONTEXT_LIMIT', 409, 'سياق الشكوى يتجاوز حد إنشاء المسودة. ابدأ شكوى جديدة مختصرة.')
    return {'draft_text': draft, 'language': language, 'service_id': service['id'] if service else None,
            'source_fact_count': 1,
            'omitted_fields': omitted, 'warnings': warnings,
            'conversation_turn_count': state.turn_count}


@router.post('/complaint-draft')
async def complaint_draft(request: DraftRequest):
    return compose_draft(_open(request.conversation_token), request.language,
                         reviewed_facts=request.reviewed_facts,
                         review_context_id_value=request.review_context_id,
                         facts_confirmed=request.facts_confirmed)
