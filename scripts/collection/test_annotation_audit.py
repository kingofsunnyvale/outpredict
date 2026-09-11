"""Offline adversarial source-evidence audit. Never calls an annotation API.

The saved pilot JSON is immutable input. Mutations prove that a verbatim span
alone cannot qualify unsupported numbers, program types, statuses, or timing.
Run: PYTHONDONTWRITEBYTECODE=1 uv run --no-project python -m unittest -v test_annotation_audit
"""
import copy
import json
from pathlib import Path
import unittest

from annotate import validate

WORK = Path(__file__).resolve().parent


def pilot(thread):
    source=next((WORK / 'state' / 'annotations').glob(f'sdn_{thread}-*-out11-extract-2.json'),None)
    if source is None:raise unittest.SkipTest('Private source pilot is not committed')
    record = json.loads(source.read_text())
    path = Path(record['packPath'])
    if not path.is_absolute():
        path = WORK / path
    return copy.deepcopy(record['facts']), json.loads(path.read_text())


def fixture(text, *, academics=None, activities=None, outcomes=None):
    data = {'cycle': '', 'cycleEvidence': [], 'academics': academics or [],
            'activities': activities or [], 'outcomes': outcomes or [], 'notes': []}
    pack = {'posts': [{'text': text, 'postId': 'synthetic-1', 'sourceUrl': 'https://example.invalid/source',
                       'sourceArtifactSha256': 'synthetic-offline', 'authoredAt': '2024-06-16T12:00:00Z'}]}
    return data, pack


@unittest.skipUnless((WORK/'state'/'annotations').exists(), 'Private source pilots are not committed; synthetic regression suite runs in CI')
class PilotMutationAudit(unittest.TestCase):
    def rejected(self, data, pack):
        result = validate(data, pack)
        self.assertTrue(result['errors'], result)
        self.assertEqual(result['decision'], 'needs_correction')
        return result

    def test_practice_score_is_not_actual_mcat_even_with_exact_quote(self):
        data, pack = pilot('1185505')
        data['academics'][2] = ['mcat', '515', '1', 'my highest practice test score was a 515']
        self.rejected(data, pack)

    def test_shortened_numeric_token_is_not_supported_by_larger_decimal(self):
        data, pack = pilot('1185505')
        data['academics'][0][1] = '3.5'
        self.rejected(data, pack)

    def test_changed_hours_are_not_supported_by_unchanged_quote(self):
        data, pack = pilot('1185505')
        data['activities'][0][2] = '7000 hours'
        self.rejected(data, pack)

    def test_deferral_is_not_waitlist(self):
        data, pack = pilot('1185505')
        data['outcomes'][0][0] = 'waitlisted'
        self.rejected(data, pack)

    def test_masters_acceptance_cannot_become_md_acceptance(self):
        data, pack = pilot('1185505')
        data['outcomes'].append(['accepted', 'MD', 'Brown', '2024-25', '', '1',
                                 'I applied and got accepted into Brown’s Masters of Medical Bioscience.'])
        self.rejected(data, pack)

    def test_postbacc_gpa_cannot_replace_undergraduate_gpa(self):
        data, pack = pilot('1192526')
        data['academics'][0] = ['gpa', '3.71', '1', 'GPA cGPA: 2.91 (postbacc 3.71)']
        self.rejected(data, pack)

    def test_hypothetical_acceptance_is_not_actual_outcome(self):
        data, pack = pilot('1184678')
        data['outcomes'].append(['accepted', 'MD', 'UTSW', '', '', '6',
                                 'if I also got accepted to UTSW (for example)'])
        self.rejected(data, pack)

    def test_unknown_status_is_not_an_outcome_enum(self):
        data, pack = pilot('1185505')
        data['outcomes'][0][0] = 'not_a_status'
        self.rejected(data, pack)

    def test_new_qualifier_outside_quote_and_retrospective_timing_are_preserved(self):
        data, pack = pilot('1192526')
        result = validate(data, pack)
        self.assertEqual(result['timingGuard'], 'outcome_snapshot_application_time_unestablished')
        for i in (3, 7):
            self.assertNotIn('(new)', data['activities'][i][-1])
            self.assertIn('(new)', result['spans'][f'activities:{i}']['context'])
            self.assertIn(f'activities:{i}:new_or_updated_activity', result['reviewFlags'])
        # Historical hours remain usable as reported facts, not silently
        # certified application-time predictors even if a model says complete.
        self.assertEqual(data['activities'][0][3], 'completed_reported')
        self.assertEqual(result['errors'], [])

    def test_known_good_pilot_facts_are_not_rejected_by_neighboring_sentences(self):
        for thread in ('1184678', '1185505', '1192526'):
            with self.subTest(thread=thread):
                data, pack = pilot(thread)
                result = validate(data, pack)
                self.assertEqual(result['errors'], [])
                self.assertEqual(result['decision'], 'requires_semantic_review')
        # Practice515 and Masters acceptance elsewhere must not taint actual510,
        # actual Drexel deferral, or actual aggregate pre-interview rejections.
        data, pack = pilot('1185505')
        self.assertEqual(data['academics'][2][1], '510')
        self.assertEqual(data['outcomes'][0][0], 'pending')
        self.assertEqual(validate(data, pack)['errors'], [])

    def test_no_outcomes_stays_unknown_and_shadowing_removal_requires_review(self):
        data, pack = pilot('1184678')
        result = validate(data, pack)
        self.assertEqual(data['outcomes'], [])
        self.assertEqual(result['timingGuard'], 'profile_snapshot_no_outcomes')
        self.assertIn('source:application_content_changed', result['reviewFlags'])
        self.assertIn('source:multiple_author_updates', result['reviewFlags'])

    def test_omitted_hours_do_not_become_zero_or_erase_roles(self):
        data, pack = pilot('1192526')
        result = validate(data, pack)
        ed = next(row for row in data['activities'] if row[1] == 'ED scribe')
        self.assertEqual(ed[2], '')
        self.assertEqual(result['errors'], [])
        ed[2] = '0 hours'
        self.rejected(data, pack)

    def test_offsets_roundtrip_original_text_and_source_identity(self):
        for thread in ('1184678', '1185505', '1192526'):
            data, pack = pilot(thread)
            result = validate(data, pack)
            self.assertEqual(result['exactSpanCount'], len(result['spans']))
            for span in result['spans'].values():
                post = next(p for p in pack['posts'] if p['postId'] == span['postId'])
                self.assertEqual(post['text'][span['start']:span['end']], span['quote'])
                self.assertEqual(span['sourceUrl'], post['sourceUrl'])
                self.assertEqual(span['sourceArtifactSha256'], post['sourceArtifactSha256'])

    def test_invented_outcome_count_is_not_supported(self):
        data, pack = pilot('1192526')
        data['outcomes'][0][4] = '20'
        result = validate(data, pack)
        self.assertEqual(result['errors'], [])
        self.assertIn('outcomes:0:count_not_in_quote', result['reviewFlags'])
        # Quantity is unusable, but the independently supported interview remains.
        self.assertEqual(result['decision'], 'requires_semantic_review')


class ContextBoundaryAudit(unittest.TestCase):
    def test_tiny_quote_cannot_hide_practice_prefix(self):
        data, pack = fixture('My highest practice MCAT was 515.', academics=[['mcat', '515', '1', '515']])
        self.assertTrue(validate(data, pack)['errors'])

    def test_actual_score_after_practice_sentence_is_supported(self):
        data, pack = fixture('My practice MCAT was 515. Actual MCAT: 510.', academics=[['mcat', '510', '1', '510']])
        self.assertEqual(validate(data, pack)['errors'], [])

    def test_tiny_quote_cannot_hide_masters_degree(self):
        data, pack = fixture('For the Masters program, I was accepted.', outcomes=[['accepted', 'MD', '', '', '', '1', 'I was accepted']])
        self.assertTrue(validate(data, pack)['errors'])

    def test_unrelated_masters_sentence_does_not_taint_medical_acceptance(self):
        data, pack = fixture('I considered a Masters program. I was accepted to an MD program.', outcomes=[['accepted', 'MD', '', '', '', '1', 'I was accepted to an MD program']])
        self.assertEqual(validate(data, pack)['errors'], [])

    def test_tiny_quote_cannot_hide_conditional_prefix(self):
        data, pack = fixture('If I got accepted to UTSW, I would attend.', outcomes=[['accepted', 'MD', 'UTSW', '', '', '1', 'I got accepted to UTSW']])
        self.assertTrue(validate(data, pack)['errors'])

    def test_actual_rejection_before_consolation_is_supported(self):
        quote = 'I was rejected pre-interview'
        data, pack = fixture(quote + " (if it's any consolation, it happened late).", outcomes=[['rejected', 'unspecified_medical', '', '', '', '1', quote]])
        self.assertEqual(validate(data, pack)['errors'], [])

    def test_explicit_negative_status_does_not_become_rejection(self):
        data, pack = fixture('Accepted: No. Rejected: No.', outcomes=[['rejected', 'MD', '', '', '', '1', 'Rejected: No']])
        self.assertTrue(validate(data, pack)['errors'])

    def test_planned_hours_cannot_be_completed_with_tiny_quote(self):
        data, pack = fixture('I have planned 200 hours of hospital volunteering.', activities=[['clinical', 'Hospital volunteering', '200 hours', 'completed_reported', '1', '200 hours of hospital volunteering']])
        self.assertTrue(validate(data, pack)['errors'])
        data['activities'][0][3] = 'planned'
        self.assertEqual(validate(data, pack)['errors'], [])

    def test_new_volunteers_in_description_does_not_make_completed_hours_planned(self):
        text = '50 hours as music leader coordinating new volunteers.'
        data, pack = fixture(text, activities=[['teaching_leadership', 'Music leader', '50 hours', 'completed_reported', '1', text]])
        self.assertEqual(validate(data, pack)['errors'], [])
        self.assertEqual(validate(data, pack)['reviewFlags'], [])

    def test_lost_approximate_and_lower_bound_qualifiers_are_rejected(self):
        for source, hours in [('About 200 hours in clinic.', '200 hours'), ('200+ hours in clinic.', '200 hours'), ('200–300 hours in clinic.', '200 hours')]:
            with self.subTest(source=source):
                data, pack = fixture(source, activities=[['clinical', 'Clinic', hours, 'completed_reported', '1', source]])
                self.assertTrue(validate(data, pack)['errors'])
        for source, hours in [('About 200 hours in clinic.', 'About 200 hours'), ('200+ hours in clinic.', '200+ hours'), ('200–300 hours in clinic.', '200–300 hours')]:
            with self.subTest(source=source):
                data, pack = fixture(source, activities=[['clinical', 'Clinic', hours, 'completed_reported', '1', source]])
                self.assertEqual(validate(data, pack)['errors'], [])

    def test_source_qualifier_cannot_be_hidden_outside_tiny_quote(self):
        for text, quote, hours in [('About 200 hours at clinic.', '200 hours at clinic', '200 hours'),
                                   ('200–300 hours at clinic.', '300 hours at clinic', '300 hours'),
                                   ('Over 200 hours at clinic.', '200 hours at clinic', 'About 200 hours')]:
            with self.subTest(text=text):
                data, pack = fixture(text, activities=[['clinical', 'Clinic', hours, 'completed_reported', '1', quote]])
                self.assertTrue(validate(data, pack)['errors'])

    def test_sentence_punctuation_is_not_part_of_numeric_token(self):
        for quote, value in [('Actual MCAT: 510.', '510'), ('Actual MCAT: 510, taken in May.', '510')]:
            data, pack = fixture(quote, academics=[['mcat', value, '1', quote]])
            self.assertEqual(validate(data, pack)['errors'], [])

    def test_paid_status_is_not_inferred_from_job_title_alone(self):
        text = 'Accounting assistant, hours unreported.'
        data, pack = fixture(text, activities=[['paid_nonclinical', 'Accounting assistant', '', 'completed_reported', '1', text]])
        result = validate(data, pack)
        self.assertEqual(result['errors'], [])
        self.assertIn('activities:0:payment_unestablished', result['reviewFlags'])

    def test_assignment_arrows_are_not_numeric_inequality_bounds(self):
        for arrow in ('->', '=>', '→'):
            text = f'Dermatology MA {arrow} 640 hrs'
            data, pack = fixture(text, activities=[['clinical', 'Dermatology MA', '640 hrs', 'completed_reported', '1', text]])
            self.assertEqual(validate(data, pack)['errors'], [])
        for bound in ('>', '≥', '<', 'less than'):
            text = f'Dermatology MA {bound} 640 hrs'
            data, pack = fixture(text, activities=[['clinical', 'Dermatology MA', '640 hrs', 'completed_reported', '1', text]])
            self.assertTrue(validate(data, pack)['errors'])
            data['activities'][0][2] = f'{bound} 640 hrs'
            self.assertEqual(validate(data, pack)['errors'], [])

    def test_range_units_and_unquantified_hours_are_independent(self):
        data, pack = fixture('20 setting up a food drive.', activities=[['nonclinical', 'Food drive', '20', 'completed_reported', '1', '20 setting up a food drive.']])
        result = validate(data, pack)
        self.assertEqual(result['errors'], [])
        self.assertIn('activities:0:hours_unit_unestablished', result['reviewFlags'])

    def test_duplicate_exact_quote_is_not_silently_disambiguated(self):
        data, pack = fixture('If I got accepted, I would attend. I got accepted.', outcomes=[['accepted', 'MD', '', '', '', '1', 'I got accepted']])
        self.assertIn('outcomes:0:ambiguous_quote_occurrence', validate(data, pack)['reviewFlags'])

    def test_invalid_row_and_post_index_fail_closed(self):
        for row in (['mcat', '510'], ['mcat', '510', '0', '510'], ['mcat', '510', '2', '510'], ['mcat', 510, '1', '510']):
            data, pack = fixture('MCAT 510.', academics=[row])
            self.assertTrue(validate(data, pack)['errors'])


class FieldReviewRegressionAudit(unittest.TestCase):
    def source_field(self, account, section, index):
        facts, pack = pilot(account)
        data, _ = fixture('', **{section: [facts[section][index]]})
        return data, pack

    def test_actual_do_acceptance_and_history_survive_other_academic_context(self):
        for index in (0, 1, 2):
            data, pack = self.source_field('1124395', 'outcomes', index)
            self.assertEqual(validate(data, pack)['errors'], [], index)
        for text in [
            "If I got into an MD program, I would attend.",
            "If I got accepted and got into an MD program, I would attend.",
            "I hoped I got into an MD program.",
            "I haven’t gotten into an MD program.",
            "I got into Brown's Masters program.",
            "For the Masters program, I was accepted.",
        ]:
            data, pack = fixture(text, outcomes=[['accepted', 'MD', '', '', '', '1', text]])
            self.assertTrue(validate(data, pack)['errors'], text)

    def test_got_into_and_attending_update_is_actual_acceptance(self):
        data, pack = self.source_field('1163823', 'outcomes', 4)
        self.assertEqual(validate(data, pack)['errors'], [])

    def test_unreported_or_unwitnessed_count_preserves_actual_status_only(self):
        for account, index in [('1158168', 0), ('1163321', 0), ('990703', 1), ('990703', 4)]:
            data, pack = self.source_field(account, 'outcomes', index)
            result = validate(data, pack)
            self.assertEqual(result['errors'], [], (account, result['errors']))
            self.assertTrue(any(flag in result['reviewFlags'] for flag in ['outcomes:0:count_format', 'outcomes:0:count_not_in_quote']))

    def test_negation_is_bound_to_the_actual_status(self):
        text = 'I was rejected by all, no interviews.'
        data, pack = fixture(text, outcomes=[['rejected', 'unspecified_medical', '', '', '', '1', text]])
        self.assertEqual(validate(data, pack)['errors'], [])
        data['outcomes'][0][0] = 'interview'
        self.assertIn('outcomes:0:explicit_negative_flag', validate(data, pack)['errors'])
        for text, status in [('Accepted: No.', 'accepted'), ('Rejections: 0.', 'rejected'), ('I never received any interviews.', 'interview'), ('No waitlists.', 'waitlisted'), ('I got 0 acceptances.', 'accepted'), ('I received zero interviews.', 'interview')]:
            data, pack = fixture(text, outcomes=[[status, 'MD', '', '', '', '1', text]])
            self.assertIn('outcomes:0:explicit_negative_flag', validate(data, pack)['errors'], text)

    def test_wl_cr_list_cannot_become_definite_waitlists_or_pending(self):
        data, pack = self.source_field('1158723', 'outcomes', 11)
        self.assertIn('outcomes:0:ambiguous_combined_status', validate(data, pack)['errors'])
        for text in ['WL / CR: Example School', 'CR/WL: Example School']:
            data, pack = fixture(text, outcomes=[['waitlisted', 'MD', 'Example School', '', '', '1', text]])
            self.assertIn('outcomes:0:ambiguous_combined_status', validate(data, pack)['errors'])
        text = 'Example A: WL. Example B: pending continued review.'
        data, pack = fixture(text, outcomes=[['waitlisted', 'MD', 'Example A', '', '', '1', 'Example A: WL']])
        self.assertEqual(validate(data, pack)['errors'], [])

    def test_completed_value_does_not_inherit_other_anticipated_quantity(self):
        data, pack = self.source_field('738822', 'activities', 1)
        self.assertEqual(validate(data, pack)['errors'], [])
        data['activities'][0][2] = '1800 hours'
        self.assertIn('activities:0:planned_as_completed', validate(data, pack)['errors'])
        data['activities'][0][3] = 'planned'
        self.assertEqual(validate(data, pack)['errors'], [])
        for text in ['1050 hours completed and anticipated 1800 hours.', '1050 hours with another 1800 anticipated.']:
            data, pack = fixture(text, activities=[['clinical', 'CNA', '1050 hours', 'completed_reported', '1', text]])
            self.assertEqual(validate(data, pack)['errors'], [], text)
            data['activities'][0][2] = '1800 hours'
            self.assertIn('activities:0:planned_as_completed', validate(data, pack)['errors'], text)

    def test_approximate_academic_witness_is_reported_but_not_exact(self):
        for text, value in [('cGPA ~3.34.', '3.34'), ('cGPA 3.34ish.', '3.34'), ('cGPA about 3.34.', '3.34'), ('cGPA 3.30–3.40.', '3.30'), ('cGPA >3.34.', '3.34')]:
            data, pack = fixture(text, academics=[['gpa', value, '1', text]])
            result = validate(data, pack)
            self.assertEqual(result['errors'], [], text)
            self.assertIn('academics:0:nonexact_measurement', result['reviewFlags'], text)
        text = 'GPA 3.3–3.4, MCAT 510.'
        data, pack = fixture(text, academics=[['mcat', '510', '1', 'MCAT 510']])
        self.assertNotIn('academics:0:nonexact_measurement', validate(data, pack)['reviewFlags'])
        data, pack = fixture('GPA 3.55ish.', academics=[['gpa', '3.5', '1', 'GPA 3.55ish.']])
        self.assertIn('academics:0:number_not_in_quote', validate(data, pack)['errors'])


class PortableAdversarialAudit(unittest.TestCase):
    def test_eight_semantic_failures_have_synthetic_offline_witnesses(self):
        examples = [
            fixture('My practice MCAT was 515.', academics=[['mcat','515','1','515']]),
            fixture('My undergraduate cGPA is 3.55.', academics=[['gpa','3.5','1','My undergraduate cGPA is 3.55.']]),
            fixture('I completed 700 hours as a CNA.', activities=[['clinical','CNA','7000 hours','completed_reported','1','I completed 700 hours as a CNA.']]),
            fixture('Medical School X deferred my application.', outcomes=[['waitlisted','unspecified_medical','Medical School X','','','1','Medical School X deferred my application.']]),
            fixture('I got accepted into the Masters program at School X.', outcomes=[['accepted','MD','School X','','','1','I got accepted into the Masters program at School X.']]),
            fixture('Postbacc GPA: 3.71.', academics=[['gpa','3.71','1','Postbacc GPA: 3.71.']]),
            fixture('If I got accepted to School X, I would move.', outcomes=[['accepted','MD','School X','','','1','got accepted to School X']]),
            fixture('I was rejected.', outcomes=[['not_a_status','unspecified_medical','','','','1','I was rejected.']]),
        ]
        for data,pack in examples:
            with self.subTest(data=data):
                self.assertTrue(validate(data,pack)['errors'])
    def test_actual_medical_status_unknown_quantity_and_pending_remain_distinct(self):
        for status,quote,count in [('accepted','I have already gotten into three DO schools.',''),('rejected','My first cycle was all rejections.','all'),('pending','Medical School X deferred my application.','')]:
            data,pack=fixture(quote,outcomes=[[status,'DO' if status=='accepted' else 'unspecified_medical','','',count,'1',quote]])
            self.assertFalse(validate(data,pack)['errors'])
        data,pack=fixture('WL/CR: School X, School Y',outcomes=[['waitlisted','unspecified_medical','School X','','','1','WL/CR: School X, School Y']])
        self.assertTrue(validate(data,pack)['errors'])


class QuantityBoundaryAudit(unittest.TestCase):
    def test_near_value_qualifiers_cannot_become_exact_hours_or_academics(self):
        for qualifier in ['Close to', 'nearly', 'almost']:
            text = f'{qualifier} 4000 hours of clinical volunteering.'
            data, pack = fixture(text, activities=[['clinical', 'Volunteer', '4000 hours', 'completed_reported', '1', '4000 hours of clinical volunteering']])
            self.assertIn('activities:0:hours_qualifier_lost', validate(data, pack)['errors'])
            data['activities'][0][2] = qualifier + ' 4000 hours'
            self.assertEqual(validate(data, pack)['errors'], [])
            text = f'My cGPA is {qualifier} 3.8.'
            data, pack = fixture(text, academics=[['gpa', '3.8', '1', '3.8']])
            self.assertIn('academics:0:nonexact_measurement', validate(data, pack)['reviewFlags'])

    def test_qualifier_on_another_quantity_does_not_taint_exact_hours(self):
        text = 'Nearly 4000 hours of clinical volunteering and 60 hours of shadowing.'
        data, pack = fixture(text, activities=[['shadowing', 'Physician shadowing', '60 hours', 'completed_reported', '1', text]])
        self.assertEqual(validate(data, pack)['errors'], [])

    def test_clinical_or_combined_total_cannot_be_dedicated_shadowing_hours(self):
        for text in [
            '1800 hours clinical volunteering (I was able to shadow physicians as well as volunteer).',
            'Clinical volunteering: 1800 hours, including occasional shadowing.',
            '1800 hours of shadowing and clinical volunteering combined.',
            'Clinical volunteering and shadowing: 1800 hours.',
            '1800 hours of shadowing/volunteering.',
        ]:
            data, pack = fixture(text, activities=[['shadowing', 'Physician shadowing', '1800 hours', 'completed_reported', '1', text]])
            with self.subTest(text=text):
                self.assertIn('activities:0:hours_category_allocation_unestablished', validate(data, pack)['errors'])
                data['activities'][0][2] = ''
                self.assertEqual(validate(data, pack)['errors'], [])

    def test_explicit_shadowing_quantity_survives_separate_clinical_work(self):
        for text, amount in [
            ('1800 hours clinical volunteering and 60 hours of shadowing.', '60'),
            ('1800 clinical volunteering hours; shadowing: 60 hours.', '60'),
            ('60 hours of shadowing during my clinical role.', '60'),
            ('Shadowing: 60 hours. Clinical volunteering: 1800 hours.', '60'),
        ]:
            data, pack = fixture(text, activities=[['shadowing', 'Physician shadowing', amount + ' hours', 'completed_reported', '1', text]])
            with self.subTest(text=text):
                self.assertEqual(validate(data, pack)['errors'], [])

    def test_compact_hour_tokens_and_units_match_without_partial_numbers(self):
        from validation import _numbers
        for raw in ['100hrs', '100hours', '100hr', '100HRS', '1,000hrs', '100.5hours']:
            text = 'Tutoring ' + raw
            data, pack = fixture(text, activities=[['teaching_leadership', 'Tutor', raw, 'completed_reported', '1', text]])
            with self.subTest(raw=raw):
                result = validate(data, pack)
                self.assertEqual(result['errors'], [])
                self.assertNotIn('activities:0:hours_unit_unestablished', result['reviewFlags'])
        self.assertEqual(_numbers('100horses 100hourly 100hrstudent x100hrs'), [])
        self.assertEqual([n for n, _, _ in _numbers('100.5hrs 1,000hrs')], ['100.5', '1,000'])
        data, pack = fixture('100.5hrs tutoring', activities=[['teaching_leadership', 'Tutor', '100 hours', 'completed_reported', '1', '100.5hrs tutoring']])
        self.assertIn('activities:0:hours_not_in_quote', validate(data, pack)['errors'])

    def test_absent_or_unrelated_unit_remains_unestablished(self):
        for text in ['Tutoring 100', '100 afterhours sessions', '100 hourslong meetings']:
            data, pack = fixture(text, activities=[['teaching_leadership', 'Tutor', '100', 'completed_reported', '1', text]])
            self.assertIn('activities:0:hours_unit_unestablished', validate(data, pack)['reviewFlags'])

    def test_normalization_preserves_role_with_unknown_allocation_and_source_precision(self):
        import tempfile
        from normalize import normalize
        examples = [
            ('1800 hours clinical volunteering (I was able to shadow as well as volunteer).', 'shadowing', '1800 hours', 'hours_category_allocation_unestablished', {'min': None, 'max': None, 'precision': 'unreported'}),
            ('Close to 4000 hours clinical volunteering.', 'clinical', '4000 hours', 'hours_qualifier_lost', {'min': 4000, 'max': 4000, 'precision': 'approximate'}),
            ('Tutoring 100hrs.', 'teaching_leadership', '100hrs', None, {'min': 100, 'max': 100, 'precision': 'reported'}),
        ]
        for text, category, hours, error, expected in examples:
            with self.subTest(text=text), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                facts, pack = fixture(text, activities=[[category, 'Reported role', hours, 'completed_reported', '1', text]])
                pack.update({'accountKey': 'sdn:synthetic', 'publicHandle': 'Synthetic', 'contentDigest': 'b'*64, 'scope': {}})
                pack['posts'][0]['observedAt'] = '2026-09-10T00:00:00Z'
                pack_path = root/'pack.json'; pack_path.write_text(json.dumps(pack))
                extraction_path = root/'extraction.json'; extraction_path.write_text(json.dumps({'facts': facts, 'contentDigest': pack['contentDigest']}))
                checked = validate(facts, pack)
                field = {'reviewStatus': 'field_reviewed_candidate', 'packPath': str(pack_path), 'extractionPath': str(extraction_path), 'contentDigest': pack['contentDigest'],
                         'supportedFields': [] if error else ['activities:0'], 'narrativeOnlyFields': ['activities:0'] if error else [],
                         'omittedFields': {'activities:0': ['activities:0:'+error]} if error else {}, 'reviewFlags': checked['reviewFlags'],
                         'reviewedAt': '2026-09-10T00:00:00Z', 'method': 'synthetic_test'}
                result = normalize(field, root/'artifacts')
                self.assertEqual(result['activities'][0]['description'], 'Reported role')
                self.assertEqual(result['activities'][0]['hours'], expected)
                self.assertEqual(result['evidenceSpans'][0]['quote'], text)


class ProgramIdentityAudit(unittest.TestCase):
    def test_named_school_does_not_supply_unreported_program_type(self):
        text = 'I was previously waitlisted post-interview at OUWB.'
        data, pack = fixture(text, outcomes=[['waitlisted', 'MD', 'OUWB', '', '', '1', text]])
        self.assertIn('outcomes:0:program_unestablished', validate(data, pack)['errors'])
        data['outcomes'][0][1] = 'unspecified_medical'
        self.assertEqual(validate(data, pack)['errors'], [])

    def test_explicit_degree_labels_and_punctuation_are_supported(self):
        for program, label in [('MD', 'MD'), ('MD', 'M.D.'), ('MD', 'Doctor of Medicine'), ('DO', 'DO'), ('DO', 'D.O.'), ('DO', 'Doctor of Osteopathic Medicine'), ('MD_PhD', 'MD/PhD'), ('MD_PhD', 'M.D.-Ph.D.')]:
            text = f'I was accepted to the {label} program.'
            data, pack = fixture(text, outcomes=[['accepted', program, '', '', '', '1', text]])
            with self.subTest(label=label):
                self.assertEqual(validate(data, pack)['errors'], [])

    def test_verbs_other_words_and_joint_degrees_do_not_imply_wrong_program(self):
        for program, text in [('DO', 'What should I do? I was accepted.'), ('DO', 'What should I DO? I was accepted.'), ('DO', 'I was accepted at DOCTOR University.'), ('MD', 'I was accepted to the MD/PhD program.'), ('DO', 'I was accepted to an MD program.'), ('MD', 'I live in MD and was accepted at School X.')]:
            data, pack = fixture(text, outcomes=[['accepted', program, '', '', '', '1', text]])
            self.assertIn('outcomes:0:program_unestablished', validate(data, pack)['errors'])
        text = 'I considered MD programs. I was accepted to School X.'
        data, pack = fixture(text, outcomes=[['accepted', 'MD', 'School X', '', '', '1', 'I was accepted to School X.']])
        self.assertIn('outcomes:0:program_unestablished', validate(data, pack)['errors'])

    def test_program_outcome_headings_remain_explicit_evidence(self):
        for program, text in [('MD', 'MD: accepted at School X.'), ('DO', 'DO: accepted at School X.'), ('DO', 'I was accepted. Degree: DO')]:
            data, pack = fixture(text, outcomes=[['accepted', program, 'School X', '', '', '1', text]])
            self.assertEqual(validate(data, pack)['errors'], [])


if __name__ == '__main__':
    unittest.main()
