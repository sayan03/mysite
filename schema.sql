-- Run in Supabase SQL editor
CREATE TABLE IF NOT EXISTS products(id SERIAL PRIMARY KEY,title TEXT,slug TEXT UNIQUE,description TEXT,category TEXT,language TEXT,price INT,discount_price INT,cover_image TEXT,file_path TEXT,page_count INT,is_active INT DEFAULT 1,is_bundle INT DEFAULT 0,created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,customer_name TEXT,customer_email TEXT,amount INT,coupon TEXT,payment_status TEXT DEFAULT 'created',razorpay_order_id TEXT UNIQUE,payment_id TEXT,created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS order_items(order_id TEXT,product_id INT);
CREATE TABLE IF NOT EXISTS downloads(id SERIAL PRIMARY KEY,order_id TEXT,product_id INT,download_token TEXT UNIQUE,expires_at BIGINT,download_count INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS coupons(code TEXT PRIMARY KEY,percent INT DEFAULT 0,fixed INT DEFAULT 0,expires_at BIGINT,usage_limit INT,used INT DEFAULT 0,is_active INT DEFAULT 1);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT);
INSERT INTO settings VALUES('brand','[YOUR BRAND NAME]'),('download_expiry_hours','48'),('max_downloads','3'),('support_email','[YOUR EMAIL]') ON CONFLICT DO NOTHING;
-- Enable RLS so the public anon key can never read these tables (backend uses the DB connection string).
ALTER TABLE products ENABLE ROW LEVEL SECURITY;ALTER TABLE orders ENABLE ROW LEVEL SECURITY;ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;ALTER TABLE downloads ENABLE ROW LEVEL SECURITY;ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
