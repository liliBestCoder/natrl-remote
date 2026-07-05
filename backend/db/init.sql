CREATE TABLE IF NOT EXISTS ir_protocols (
  id SERIAL PRIMARY KEY,
  brand_code TEXT NOT NULL UNIQUE,
  brand_name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  carrier_freq INTEGER NOT NULL DEFAULT 38000,
  bit_length INTEGER NOT NULL,
  encoding_params JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS captured_signals (
  id SERIAL PRIMARY KEY,
  device_id TEXT NOT NULL,
  raw_timing INTEGER[] NOT NULL,
  matched_brand_code TEXT REFERENCES ir_protocols(brand_code),
  match_confidence REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed data: top 6 AC brands by China market share, NEC format
INSERT INTO ir_protocols (brand_code, brand_name, protocol, bit_length, encoding_params) VALUES
  ('gree_nec_v1', 'Gree', 'NEC', 32, '{"header_mark": 9000, "header_space": 4500, "bit_mark": 560, "one_space": 1690, "zero_space": 560, "temp_offset": 16, "temp_lsb": 4}'),
  ('midea_nec_v1', 'Midea', 'NEC', 32, '{"header_mark": 4400, "header_space": 4400, "bit_mark": 560, "one_space": 1690, "zero_space": 560, "temp_offset": 17, "temp_lsb": 0}'),
  ('haier_nec_v1', 'Haier', 'NEC', 32, '{"header_mark": 9000, "header_space": 4500, "bit_mark": 560, "one_space": 1690, "zero_space": 560, "temp_offset": 16, "temp_lsb": 4}'),
  ('aux_nec_v1', 'Aux', 'NEC', 32, '{"header_mark": 9000, "header_space": 4500, "bit_mark": 560, "one_space": 1690, "zero_space": 560, "temp_offset": 16, "temp_lsb": 4}'),
  ('daikin_nec_v1', 'Daikin', 'NEC', 32, '{"header_mark": 9000, "header_space": 4500, "bit_mark": 560, "one_space": 1690, "zero_space": 560, "temp_offset": 16, "temp_lsb": 4}'),
  ('panasonic_nec_v1', 'Panasonic', 'NEC', 32, '{"header_mark": 3500, "header_space": 1750, "bit_mark": 435, "one_space": 1300, "zero_space": 435, "temp_offset": 16, "temp_lsb": 4}')
ON CONFLICT (brand_code) DO NOTHING;
