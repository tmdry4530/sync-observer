-- 0001_extensions.sql
-- Enable the cryptographic helpers used across the schema (gen_random_uuid, crypt).
create extension if not exists pgcrypto;
