"""Deterministic evidence gates; exact spans do not certify narrative semantics.

Offsets use Python Unicode code points into the immutable review-pack post text.
The caller must still independently review outcomes, conflicts, multiple updates,
and reviewFlags. Reported hours never imply hours available at application time.
"""
import re

ACADEMIC_FIELDS = {'gpa', 'scienceGpa', 'mcat', 'residence'}
CATEGORIES = {'clinical', 'research', 'nonclinical', 'shadowing', 'teaching_leadership', 'paid_nonclinical', 'other'}
TIMINGS = {'completed_reported', 'planned', 'retrospective_mixed', 'unknown'}
STATUSES = {'accepted', 'rejected', 'interview', 'waitlisted', 'withdrawn', 'pending'}
PROGRAMS = {'MD', 'DO', 'MD_PhD', 'unspecified_medical'}
NUMBER = re.compile(r'(?<![\w.,])\d+(?:,\d{3})*(?:\.\d+)?(?=ish\b|(?:hours?|hrs?)\b|(?!\w|\.\d|,\d))', re.I)
HOUR_UNIT = re.compile(r'(?<![a-z])(?:hours?|hrs?)\b', re.I)
SENTENCE_END = re.compile(r'[.!?](?=\s|$)|[;\n]')
FUTURE = re.compile(r'\b(?:projected|planned|anticipated|expect(?:ed|ing)?|will\s+(?:have|start|complete|earn)|hope\s+to|hoping\s+to)\b', re.I)
WORDS = {'1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine', '10': 'ten'}


def _numbers(text):
    # A comma, period, or adjacent digit cannot be silently discarded: 3.5 is
    # not a witness for 3.55, nor is 500 a witness for 1,500.
    return [(m.group(), m.start(), m.end()) for m in NUMBER.finditer(text)]


def _sentence_bounds(text, start, end):
    left, right = 0, len(text)
    for boundary in SENTENCE_END.finditer(text):
        if boundary.end() <= start:
            left = boundary.end()
        elif boundary.start() >= end:
            right = boundary.end()
            break
    return left, right


def _prefix(text, pos, limit=100):
    left, _ = _sentence_bounds(text, pos, pos)
    return text[max(left, pos-limit):pos]


def _token_modifiers(text, start, end):
    """Keep modifiers attached to this value, not a different nearby role."""
    before = _prefix(text, start, 55)
    after = text[end:end+45]
    return before, after


def _nonactual_numeric(key, text, start, end):
    before, after = _token_modifiers(text, start, end)
    if key == 'mcat':
        # Actual/test labels between a practice reference and this value reset
        # its scope. Restrict the suffix to a direct label (e.g. '515 practice').
        before = re.split(r'\b(?:actual|official|real)\s+(?:MCAT|test|score)|\b(?:actual|official|real)\s*[:=-]', before, flags=re.I)[-1]
        excluded = r'practice|practi[cse]|\bFL\s*\d*\b|projected|predict\w*|aiming|hoping|goal|expected'
        if re.search(excluded, before, re.I) or re.match(r'\s*(?:\([^)]*)?(?:practice|projected|predicted)\b', after, re.I):
            return 'practice_or_projected'
    else:
        # Parentheses/commas delimit other GPA values; inspect the nearest
        # degree qualifier before this specific value, not the full quote.
        nearest = re.split(r'[(),;]|\b(?:cGPA|sGPA|undergrad(?:uate)?|overall)\s*[:=-]?', before, flags=re.I)[-1]
        if re.search(r'(?:post[ -]?bacc\w*|graduate|grad\s+GPA|masters?|master.s|SMP)[^\d]*$', nearest, re.I):
            return 'graduate_or_postbacc'
        if re.match(r'\s*\((?:post[ -]?bacc\w*|graduate|masters?|SMP)\b', after, re.I):
            # "2.91 (postbacc 3.71)" is a separate value, not a qualifier on
            # 2.91. Only a label without another numeric token qualifies it.
            closing = after.find(')')
            if closing >= 0 and not _numbers(after[:closing]):
                return 'graduate_or_postbacc'
    return None


def _precision(before, after):
    if re.match(r'(?:-?ish)\b', after, re.I):
        return 'approximate'
    if re.search(r'(?:[~≈]|\b(?:about|around|approximately|roughly|close\s+to|nearly|almost))\s*$', before, re.I):
        return 'approximate'
    if re.search(r'(?:≥|\b(?:at least))\s*$', before, re.I):
        return 'lower_inclusive'
    if re.search(r'(?:(?<![-=])>|\b(?:over|more than))\s*$', before, re.I):
        return 'lower_exclusive'
    if re.search(r'(?:≤|\b(?:up to|at most))\s*$', before, re.I):
        return 'upper_inclusive'
    if re.search(r'(?:<|\b(?:under|less than))\s*$', before, re.I):
        return 'upper_exclusive'
    if re.match(r'\s*\+', after):
        return 'lower_plus'
    return 'exact'


def _outcome_context(match):
    text = match['post']['text']
    left, right = _sentence_bounds(text, match['start'], match['end'])
    # A trailing parenthetical such as "if it's any consolation, I was
    # rejected..." must not turn the preceding actual rejection hypothetical.
    return text[left:match['end']], text[match['end']:right]


def _future_value_context(text, start, end):
    """Local role/value clause, so a different anticipated quantity stays separate."""
    left, right = _sentence_bounds(text, start, end)
    boundaries = re.compile(r'[(),;]|\b(?:and|with|plus)\s+(?=(?:(?:another|additional|anticipated|planned|projected|about)\s+)*[~≈]?\d)', re.I)
    for boundary in boundaries.finditer(text, left, right):
        if boundary.end() <= start:
            left = boundary.end()
        elif boundary.start() >= end:
            right = boundary.start()
            break
    return text[left:right]


def _shadowing_allocation_unestablished(text, start, end):
    """A clinical/combined quantity cannot become a dedicated shadowing count.

    Check the selected numeric clause so a nearby separate shadowing quantity
    remains usable. A directly labeled shadowing quantity may occur during a
    clinical role; that is different from an undivided combined-role total.
    """
    clause = _future_value_context(text, start, end)
    clinical = r'\b(?:clinical|volunteer\w*|patient[- ]care|scrib\w*|CNA)\b'
    shadow = r'\bshadow\w*\b'
    if not re.search(clinical, clause, re.I):
        return False
    combined = (shadow + r'[^,;.()]{0,45}\b(?:and|as\s+well\s+as)\b[^,;.()]{0,45}' + clinical +
                '|' + clinical + r'[^,;.()]{0,45}\b(?:and|as\s+well\s+as)\b[^,;.()]{0,45}' + shadow +
                '|' + shadow + r'\s*[&/]\s*' + clinical + '|' + clinical + r'\s*[&/]\s*' + shadow)
    if re.search(combined, clause, re.I):
        return True
    before, after = _token_modifiers(text, start, end)
    direct_before = re.search(r'\bshadow\w*\s*(?:(?:for|about|around|approximately|nearly|almost|close\s+to)\s*)?[:=~≈-]?\s*$', before, re.I)
    direct_after = re.match(r'\s*(?:hours?|hrs?)\s*(?:of\s+)?(?:(?:physician|virtual)\s+)?shadow\w*\b', after, re.I)
    return not (direct_before or direct_after)


def _conditional_context(context):
    # "What should I do ... and was previously waitlisted?" reports history.
    # A new explicit past/present clause does not inherit an earlier question.
    # Never drop a real conditional/hope prefix just because it contains 'and got'.
    if re.search(r'\b(?:if|would|hope[ds]?|hoping|wish(?:ed)?)\b', context, re.I):
        return context
    return re.split(r'\b(?:and|but|however)\s+(?:I\s+)?(?=was\b|have\s+(?:already\s+)?(?:been|gotten)\b|got\b)', context, flags=re.I)[-1]


def _negates_status(quote, status):
    terms = {
        'accepted': r'accept\w*|admitt\w*|admission|acceptance|A',
        'rejected': r'reject\w*|denied|R',
        'interview': r'interview\w*|II',
        'waitlisted': r'wait.?list\w*|WL',
    }.get(status)
    if not terms:
        return False
    if status == 'accepted' and re.search(r"\b(?:not|never|haven['’]t|hadn['’]t|didn['’]t)\s+(?:yet\s+)?(?:get|got|gotten)\s+in(?:to)?\b", quote, re.I):
        return True
    modifiers = r'(?:(?:any|an?|ever|yet|been|received|actual|reported|prior|previous|additional|more|medical|school|MD|DO)\s+){0,4}'
    return bool(re.search(r'(?:' + terms + r')\s*[:?]?\s*(?:no|zero|0)\b|\b(?:no|not|never|zero|0)\s+' + modifiers + r'(?:' + terms + r')\b', quote, re.I))


def _reported_programs(quote):
    """Degree labels must be stated, not inferred from a school name.

    Strip a joint-degree label before recognizing MD. Abbreviations require a
    degree/program/outcome-label context, not a verb or a state abbreviation.
    """
    programs = set()
    joint = re.compile(r'(?<!\w)M\.?D\.?\s*[-/_ ]\s*Ph\.?D\.?(?!\w)', re.I)
    if joint.search(quote):
        programs.add('MD_PhD')
    remaining = joint.sub(' ', quote)
    if re.search(r'\bdoctor\s+of\s+medicine\b', remaining, re.I):
        programs.add('MD')
    if re.search(r'\bdoctor\s+of\s+osteopathic\s+medicine\b', remaining, re.I):
        programs.add('DO')
    for program, pattern in [('MD', r'(?<!\w)M\.?D\.?(?!\w)'), ('DO', r'(?<!\w)D\.?O\.?(?!\w)')]:
        for label in re.finditer(pattern, remaining):
            before, after = remaining[:label.start()], remaining[label.end():]
            described = re.match(r'\s*(?:programs?|schools?|degrees?|acceptances?|admissions?|interviews?)\b', after, re.I)
            named_degree = re.search(r'\b(?:program|degree)\s*[:=(]?\s*$', before, re.I)
            outcome_heading = re.search(r'(?:^|[;\n])\s*$', before) and re.match(r'\s*[:=-]\s*(?:accepted|rejected|waitlisted|interviews?|A\b|R\b|WL\b|II\b)', after, re.I)
            if described or named_degree or outcome_heading:
                programs.add(program)
    return programs


def validate(data, pack):
    problems, flags, spans, resolved = [], [], [], {}
    if not isinstance(data, dict):
        return {'exactSpanCount': 0, 'errors': ['object_required'], 'reviewFlags': [], 'timingGuard': 'unestablished', 'decision': 'needs_correction', 'spans': {}}
    for section in ['academics', 'activities', 'outcomes', 'notes', 'cycleEvidence']:
        if not isinstance(data.get(section), list):
            problems.append(section + ':array_required')
    if not isinstance(data.get('cycle'), str):
        problems.append('cycle:string_required')
    if problems:
        return {'exactSpanCount': 0, 'errors': problems, 'reviewFlags': [], 'timingGuard': 'unestablished', 'decision': 'needs_correction', 'spans': {}}
    if any(not isinstance(note, str) for note in data['notes']):
        problems.append('notes:string_required')
    if data['cycle'] and not re.fullmatch(r'20\d{2}-\d{2}', data['cycle']):
        problems.append('cycle_format')
    if data['cycle'] and len(data['cycleEvidence']) != 2:
        problems.append('missing_cycle_evidence')
    if len(data['cycleEvidence']) not in (0, 2):
        problems.append('cycle_evidence_length')
    valid_rows = {}
    for section, width in [('academics', 4), ('activities', 6), ('outcomes', 7)]:
        valid_rows[section] = []
        for i, row in enumerate(data[section]):
            field = f'{section}:{i}'
            if not isinstance(row, list) or len(row) != width or any(not isinstance(x, str) for x in row):
                problems.append(field + ':row_shape')
                continue
            valid_rows[section].append((i, row))
            spans.append((field, row[-2], row[-1]))
    if len(data['cycleEvidence']) == 2:
        spans.append(('cycle', *data['cycleEvidence']))
    for field, index, quote in spans:
        if not isinstance(index, str) or not re.fullmatch(r'[1-9]\d*', index) or int(index) > len(pack['posts']):
            problems.append(field + ':post_index')
            continue
        post = pack['posts'][int(index)-1]
        if not isinstance(quote, str) or not quote or quote not in post['text']:
            problems.append(field + ':nonverbatim_quote')
            continue
        start = post['text'].index(quote)
        left, right = _sentence_bounds(post['text'], start, start+len(quote))
        resolved[field] = {'post': post, 'start': start, 'end': start+len(quote), 'quote': quote,
                           'context': post['text'][max(left, start-220):min(right, start+len(quote)+160)]}
        if post['text'].find(quote, start+1) != -1:
            # The model's tuple has no occurrence offset. Do not choose between
            # an actual and hypothetical occurrence without semantic review.
            flags.append(field + ':ambiguous_quote_occurrence')
    if data['cycle'] and 'cycle' in resolved and data['cycle'] not in resolved['cycle']['quote']:
        problems.append('cycle:not_in_quote')

    for i, row in valid_rows['academics']:
        key, value, _, quote = row
        field = f'academics:{i}'
        if key not in ACADEMIC_FIELDS:
            problems.append(field + ':field_enum')
        if key not in {'gpa', 'scienceGpa', 'mcat'}:
            continue
        if not re.fullmatch(r'\d+(?:\.\d+)?', value):
            problems.append(field + ':numeric_format')
            continue
        number = float(value)
        if (key == 'mcat' and not (472 <= number <= 528 and number.is_integer())) or (key != 'mcat' and not 0 <= number <= 4):
            problems.append(field + ':numeric_range')
        positions = [(start, end) for n, start, end in _numbers(quote) if n == value]
        if not positions:
            problems.append(field + ':number_not_in_quote')
        match = resolved.get(field)
        if match:
            for start, end in positions:
                reason = _nonactual_numeric(key, match['post']['text'], match['start']+start, match['start']+end)
                if reason:
                    problems.append(field + ':' + reason)
                before, after = _token_modifiers(match['post']['text'], match['start']+start, match['start']+end)
                nearby_start = max(0, match['start']+start-20)
                nearby = match['post']['text'][nearby_start:match['start']+end+20]
                selected_start = match['start']+start-nearby_start
                selected_end = match['start']+end-nearby_start
                range_witness = any(r.start() <= selected_start and selected_end <= r.end()
                                    for r in re.finditer(r'(?<![\w.])\d+(?:\.\d+)?\s*[-–—]\s*\d+(?:\.\d+)?', nearby))
                if _precision(before, after) != 'exact' or range_witness:
                    flags.append(field + ':nonexact_measurement')

    for i, row in valid_rows['activities']:
        category, _, hours, timing, _, quote = row
        field = f'activities:{i}'
        if category not in CATEGORIES:
            problems.append(field + ':category_enum')
        if category == 'paid_nonclinical' and not re.search(r'\b(?:paid|salary|salaried|wages?|compensated|paying)\b', quote, re.I):
            flags.append(field + ':payment_unestablished')
        if timing not in TIMINGS:
            problems.append(field + ':timing_enum')
        values = _numbers(hours)
        witnesses = _numbers(quote)
        for number, _, _ in values:
            if not any(n == number for n, _, _ in witnesses):
                problems.append(field + ':hours_not_in_quote')
        if hours and not values and not re.fullmatch(r'\s*(?:none|zero|no(?:\s+hours)?)\s*', hours, re.I):
            problems.append(field + ':unparsed_hours')
        if hours and not values and hours.lower().strip() not in quote.lower():
            problems.append(field + ':absence_not_in_quote')
        if values and not HOUR_UNIT.search(quote):
            # "20 setting up a food drive" may be a contextual hour count; it
            # is still not an independently witnessed unit for normalization.
            flags.append(field + ':hours_unit_unestablished')
        match = resolved.get(field)
        if not match:
            continue
        text = match['post']['text']
        if category == 'shadowing':
            for value, _, _ in values:
                positions = [(start, end) for witness, start, end in witnesses if witness == value]
                if positions and all(_shadowing_allocation_unestablished(text, match['start']+start, match['start']+end)
                                     for start, end in positions):
                    # Quantity-only hard error: independently supported role
                    # narrative can survive review with its hours unknown.
                    problems.append(field + ':hours_category_allocation_unestablished')
        prefix = _prefix(text, match['start'], 55)
        if re.search(r'\(new\)\s*$', prefix, re.I) or re.match(r'\s*\(new\)', quote, re.I):
            flags.append(field + ':new_or_updated_activity')
        # Only modifiers attached to the selected role/value are relevant.
        # "new volunteers" or "expected" in a later unrelated role is not.
        future = False
        if values:
            for value, _, _ in values:
                contexts = [_future_value_context(text, match['start']+start, match['start']+end)
                            for witness, start, end in witnesses if witness == value]
                if contexts and all(FUTURE.search(context) for context in contexts):
                    future = True
                elif any(FUTURE.search(context) for context in contexts):
                    flags.append(field + ':ambiguous_value_timing')
        else:
            future = bool(FUTURE.search(quote) or FUTURE.search(re.split(r'[,;()]', prefix)[-1]))
        if future and timing == 'completed_reported':
            problems.append(field + ':planned_as_completed')
        if re.search(r'\b(?:remov\w*|not includ\w*|exclud\w*)\b', quote, re.I):
            flags.append(field + ':submission_inclusion_unestablished')
        for number, _, _ in values:
            for witness, start, end in witnesses:
                if witness != number:
                    continue
                before, after = _token_modifiers(text, match['start']+start, match['start']+end)
                source_precision = _precision(before, after)
                hour_positions = [(hs, he) for hn, hs, he in values if hn == number]
                if source_precision != 'exact' and not any(_precision(hours[:hs], hours[he:]) == source_precision for hs, he in hour_positions):
                    problems.append(field + ':hours_qualifier_lost')
        # Ranges are one measurement. Keeping only an endpoint fabricates an
        # exact number even when that endpoint happens to be a verbatim token.
        range_context = text[max(0, match['start']-25):match['end']+25]
        for range_match in re.finditer(r'(\d+(?:,\d{3})*(?:\.\d+)?)\s*[-–—]\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:hours?|hrs?)\b', range_context, re.I):
            endpoints = set(range_match.group(1, 2))
            selected = {n for n, _, _ in values}
            if selected & endpoints and not endpoints <= selected:
                problems.append(field + ':hours_range_lost')

    for i, row in valid_rows['outcomes']:
        status, program, _, cycle, count, _, quote = row
        field = f'outcomes:{i}'
        if status not in STATUSES:
            problems.append(field + ':status_enum')
        if program not in PROGRAMS:
            problems.append(field + ':program_enum')
        if cycle and not re.fullmatch(r'20\d{2}-\d{2}', cycle):
            problems.append(field + ':cycle_format')
        if count:
            if not re.fullmatch(r'[1-9]\d*', count):
                flags.append(field + ':count_format')
            elif count not in {n for n, _, _ in _numbers(quote)} and not (count == '2' and re.search(r'\bboth\b', quote, re.I)):
                if count not in WORDS or not re.search(r'\b' + WORDS[count] + r'\b', quote, re.I):
                    flags.append(field + ':count_not_in_quote')
        match = resolved.get(field)
        if not match:
            continue
        if program in PROGRAMS - {'unspecified_medical'} and program not in _reported_programs(quote):
            problems.append(field + ':program_unestablished')
        patterns = {'waitlisted': r'wait.?list|\bWL\b', 'accepted': r'accept|admitt|\bA\b|\bgot(?:ten)?\s+in(?:to)?\b',
                    'rejected': r'reject|\bR\b|denied', 'interview': r'interview|\bII\b',
                    'withdrawn': r'withdr(?:aw|ew|awn)|\bWD\b', 'pending': r'defer|on.?hold|pending|await|waiting|no response|not heard'}
        if status in patterns and not re.search(patterns[status], quote, re.I):
            problems.append(field + ':status_not_in_quote')
        context, suffix = _outcome_context(match)
        nonmedical = r'\b(?:masters?|master.s|bioscience|post[ -]?bacc\w*|SMP|undergrad(?:uate)?)\b'
        medical_target = r'\b(?:MD(?:[/ -]?PhD)?|DO|medical)\s+(?:schools?|programs?)\b'
        medical_mentions = list(re.finditer(medical_target, context, re.I))
        nonmedical_mentions = list(re.finditer(nonmedical, context, re.I))
        explicit_medical_target = medical_mentions and (not nonmedical_mentions or medical_mentions[-1].start() > nonmedical_mentions[-1].start())
        if re.search(nonmedical, quote, re.I) or (nonmedical_mentions and not explicit_medical_target):
            problems.append(field + ':nonmedical_program_context')
        combined = r'\b(?:WL\s*[/|]\s*(?:CR|continued\s+(?:review|consideration))|(?:CR|continued\s+(?:review|consideration))\s*[/|]\s*WL)\b'
        if status in {'waitlisted', 'pending'} and re.search(combined, context, re.I):
            problems.append(field + ':ambiguous_combined_status')
        if status in {'accepted', 'rejected', 'interview', 'waitlisted'}:
            if _negates_status(quote, status):
                problems.append(field + ':explicit_negative_flag')
            conditional = r'\b(?:if|would|could|should|hope[ds]?|hoping|wish(?:ed)?|hypothetical)\b[^.!?]{0,130}(?:accept|reject|admit|interview|wait.?list|got(?:ten)?\s+in(?:to)?)'
            if re.search(conditional, _conditional_context(context), re.I) or re.match(r'\s+(?:if|provided that|assuming)\b', suffix, re.I):
                problems.append(field + ':conditional_or_hypothetical_context')
    if len(pack['posts']) > 1:
        flags.append('source:multiple_author_updates')
    if any(re.search(r'\b(?:will remove|not includ\w*|exclud\w*)\b.{0,90}\b(?:app|application)\b', post['text'], re.I) for post in pack['posts']):
        flags.append('source:application_content_changed')
    timing_guard = 'outcome_snapshot_application_time_unestablished' if data['outcomes'] else 'profile_snapshot_no_outcomes'
    return {'exactSpanCount': len(resolved), 'errors': list(dict.fromkeys(problems)),
            'reviewFlags': list(dict.fromkeys(flags)), 'timingGuard': timing_guard,
            'decision': 'needs_correction' if problems else 'requires_semantic_review',
            'spans': {key: {'postId': value['post']['postId'], 'sourceUrl': value['post']['sourceUrl'],
                            'sourceArtifactSha256': value['post']['sourceArtifactSha256'],
                            'start': value['start'], 'end': value['end'], 'quote': value['quote'],
                            'context': value['context']}
                      for key, value in resolved.items()}}
