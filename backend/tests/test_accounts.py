from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mongomock
from fastapi.testclient import TestClient

import accounts
from main import app


class AsyncCollection:
    def __init__(self, collection):
        self.collection = collection

    def __getattr__(self, name):
        method = getattr(self.collection, name)

        async def call(*args, **kwargs):
            return method(*args, **kwargs)
        return call


class AsyncDatabase:
    def __init__(self):
        self.db = mongomock.MongoClient().wajhah

    def __getattr__(self, name):
        return AsyncCollection(self.db[name])


USER = {'name': 'Khaled Alrumayzan', 'email': 'Khaled@Example.com', 'phone': '0501234567',
        'password': 'secret123', 'user_type': 'citizen'}


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.db = AsyncDatabase()
        accounts.use_database(self.db)
        self.codes = []
        sender = patch.object(accounts, 'send_code', side_effect=lambda email, code, language: self.codes.append(code))
        sender.start()
        self.addCleanup(sender.stop)
        self.addCleanup(accounts.use_database, None)
        self.client = TestClient(app)

    def register(self, **changes):
        return self.client.post('/auth/register', json={**USER, **changes})

    def signed_in(self):
        self.register()
        self.client.post('/auth/verify', json={'email': USER['email'], 'code': self.codes[-1]})
        token = self.client.post('/auth/login', json={'email': USER['email'], 'password': USER['password']}).json()['token']
        return {'Authorization': f'Bearer {token}'}

    def test_us01_create_account_stores_hashed_password_and_sends_code(self):
        response = self.register()
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json(), {'email': 'khaled@example.com', 'code_sent': True})
        user = self.db.db.users.find_one({'email': 'khaled@example.com'})
        self.assertEqual(user['phone'], '+966501234567')
        self.assertFalse(user['verified'])
        self.assertNotIn('secret123', user['password_hash'])
        self.assertEqual(len(self.codes), 1)

    def test_us02_invalid_details_are_reported_per_field(self):
        response = self.register(name='1', email='bad', phone='123', password='short', user_type='admin')
        self.assertEqual(response.status_code, 422)
        detail = response.json()['detail']
        self.assertEqual(detail['code'], 'INVALID_DETAILS')
        self.assertEqual(detail['fields'], {'name': 'INVALID_NAME', 'email': 'INVALID_EMAIL', 'phone': 'INVALID_PHONE',
                                            'password': 'WEAK_PASSWORD', 'user_type': 'INVALID_USER_TYPE'})
        self.assertIsNone(self.db.db.users.find_one())

    def test_us02_accepts_arabic_name_and_international_phone(self):
        response = self.register(name='خالد الرميزان', phone='+44 7700 900123', user_type='visitor')
        self.assertEqual(response.status_code, 201)

    def test_us03_duplicate_email_is_rejected(self):
        self.register()
        response = self.register(email='KHALED@example.com ', phone='0559999999')
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()['detail']['fields'], {'email': 'EMAIL_TAKEN'})

    def test_us03_duplicate_phone_is_rejected_in_any_format(self):
        self.register()
        response = self.register(email='other@example.com', phone='+966 50 123 4567')
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()['detail']['fields'], {'phone': 'PHONE_TAKEN'})

    def test_us04_unverified_account_cannot_sign_in(self):
        self.register()
        response = self.client.post('/auth/login', json={'email': USER['email'], 'password': USER['password']})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()['detail']['code'], 'ACCOUNT_NOT_VERIFIED')

    def test_us04_verify_with_correct_code(self):
        self.register()
        wrong = '000000' if self.codes[-1] != '000000' else '111111'
        self.assertEqual(self.client.post('/auth/verify', json={'email': USER['email'], 'code': wrong}).json()['detail']['code'], 'INVALID_CODE')
        response = self.client.post('/auth/verify', json={'email': USER['email'], 'code': self.codes[-1]})
        self.assertEqual(response.json(), {'verified': True})
        again = self.client.post('/auth/verify', json={'email': USER['email'], 'code': self.codes[-1]})
        self.assertEqual(again.json()['detail']['code'], 'ALREADY_VERIFIED')

    def test_us04_code_attempts_are_limited(self):
        self.register()
        wrong = '000000' if self.codes[-1] != '000000' else '111111'
        for _ in range(accounts.MAX_CODE_ATTEMPTS):
            self.client.post('/auth/verify', json={'email': USER['email'], 'code': wrong})
        response = self.client.post('/auth/verify', json={'email': USER['email'], 'code': self.codes[-1]})
        self.assertEqual(response.status_code, 429)

    def test_us04_expired_code_and_resend(self):
        self.register()
        self.db.db.users.update_one({}, {'$set': {'code_expires_at': 0}})
        response = self.client.post('/auth/verify', json={'email': USER['email'], 'code': self.codes[-1]})
        self.assertEqual(response.json()['detail']['code'], 'CODE_EXPIRED')
        self.assertEqual(self.client.post('/auth/resend-code', json={'email': USER['email']}).status_code, 429)
        self.db.db.users.update_one({}, {'$set': {'code_sent_at': 0}})
        self.assertEqual(self.client.post('/auth/resend-code', json={'email': USER['email']}).json(), {'code_sent': True})
        response = self.client.post('/auth/verify', json={'email': USER['email'], 'code': self.codes[-1]})
        self.assertEqual(response.json(), {'verified': True})

    def test_us05_sign_in(self):
        self.register()
        self.client.post('/auth/verify', json={'email': USER['email'], 'code': self.codes[-1]})
        wrong = self.client.post('/auth/login', json={'email': USER['email'], 'password': 'wrongpass1'})
        self.assertEqual(wrong.status_code, 401)
        response = self.client.post('/auth/login', json={'email': 'khaled@example.com', 'password': USER['password']})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['user']['name'], USER['name'])
        self.assertTrue(response.json()['token'])

    def test_us05_sign_out_ends_session(self):
        headers = self.signed_in()
        self.assertEqual(self.client.post('/auth/logout', headers=headers).json(), {'signed_out': True})
        self.assertEqual(self.client.get('/profile', headers=headers).status_code, 401)

    def test_us06_view_and_update_profile(self):
        headers = self.signed_in()
        self.assertEqual(self.client.get('/profile').status_code, 401)
        self.assertEqual(self.client.get('/profile', headers=headers).json()['email'], 'khaled@example.com')
        response = self.client.patch('/profile', headers=headers, json={'name': 'Khaled A', 'phone': '0551112222', 'user_type': 'resident'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual((response.json()['name'], response.json()['phone'], response.json()['user_type']),
                         ('Khaled A', '+966551112222', 'resident'))
        self.assertEqual(self.client.get('/profile', headers=headers).json()['phone'], '+966551112222')

    def test_us06_update_validates_and_prevents_duplicate_phone(self):
        headers = self.signed_in()
        self.register(email='other@example.com', phone='0559999999')
        invalid = self.client.patch('/profile', headers=headers, json={'phone': 'abc'})
        self.assertEqual(invalid.json()['detail']['fields'], {'phone': 'INVALID_PHONE'})
        taken = self.client.patch('/profile', headers=headers, json={'phone': '0559999999'})
        self.assertEqual(taken.status_code, 409)
        self.assertEqual(self.client.patch('/profile', headers=headers, json={'email': 'x@example.com'}).status_code, 422)

    def test_us07_delete_account_requires_password(self):
        headers = self.signed_in()
        wrong = self.client.request('DELETE', '/profile', headers=headers, json={'password': 'wrongpass1'})
        self.assertEqual(wrong.json()['detail']['fields'], {'password': 'WRONG_PASSWORD'})
        response = self.client.request('DELETE', '/profile', headers=headers, json={'password': USER['password']})
        self.assertEqual(response.json(), {'deleted': True})
        self.assertIsNone(self.db.db.users.find_one())
        self.assertEqual(self.client.get('/profile', headers=headers).status_code, 401)
        login = self.client.post('/auth/login', json={'email': USER['email'], 'password': USER['password']})
        self.assertEqual(login.status_code, 401)
        self.assertEqual(self.register().status_code, 201)


if __name__ == '__main__':
    unittest.main()
