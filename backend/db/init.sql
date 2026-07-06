CREATE TABLE IF NOT EXISTS ir_protocols (
  id INT AUTO_INCREMENT PRIMARY KEY,
  brand_code VARCHAR(64) NOT NULL,
  brand_name VARCHAR(128) NOT NULL,
  protocol VARCHAR(32) NOT NULL,
  carrier_freq INTEGER NOT NULL DEFAULT 38000,
  bit_length INTEGER NOT NULL,
  encoding_params JSON NOT NULL DEFAULT ('{}'),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_brand_code (brand_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS captured_signals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  device_id VARCHAR(128) NOT NULL,
  raw_timing JSON NOT NULL,
  matched_brand_code VARCHAR(64),
  match_confidence FLOAT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (matched_brand_code) REFERENCES ir_protocols(brand_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed data: top 6 AC brands by China market share, NEC format
INSERT IGNORE INTO ir_protocols (brand_code, brand_name, protocol, bit_length, encoding_params) VALUES
  ('gree_nec_v1', 'Gree', 'NEC', 32, '{"header_mark": 9000, "header_space": 4500, "bit_mark": 560, "one_space": 1690, "zero_space": 560, "temp_offset": 16, "temp_lsb": 4}'),
  ('midea_nec_v1', 'Midea', 'NEC', 32, '{"header_mark": 4400, "header_space": 4400, "bit_mark": 560, "one_space": 1690, "zero_space": 560, "temp_offset": 17, "temp_lsb": 0}'),
  ('haier_nec_v1', 'Haier', 'NEC', 32, '{"header_mark": 9000, "header_space": 4500, "bit_mark": 560, "one_space": 1690, "zero_space": 560, "temp_offset": 16, "temp_lsb": 4}'),
  ('aux_nec_v1', 'Aux', 'NEC', 32, '{"header_mark": 9000, "header_space": 4500, "bit_mark": 560, "one_space": 1690, "zero_space": 560, "temp_offset": 16, "temp_lsb": 4}'),
  ('daikin_nec_v1', 'Daikin', 'NEC', 32, '{"header_mark": 9000, "header_space": 4500, "bit_mark": 560, "one_space": 1690, "zero_space": 560, "temp_offset": 16, "temp_lsb": 4}'),
  ('panasonic_nec_v1', 'Panasonic', 'NEC', 32, '{"header_mark": 3500, "header_space": 1750, "bit_mark": 435, "one_space": 1300, "zero_space": 435, "temp_offset": 16, "temp_lsb": 4}');

-- ============================================================
-- Real IR Code Database (from IRremoteESP8266)
-- ============================================================

CREATE TABLE IF NOT EXISTS ir_codes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  brand_code VARCHAR(64) NOT NULL,
  temperature INTEGER NOT NULL,
  mode VARCHAR(16) NOT NULL,
  fan_speed VARCHAR(16) NOT NULL,
  carrier_freq INTEGER NOT NULL,
  raw_timing JSON NOT NULL,
  state_bytes VARCHAR(128),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_temperature CHECK (temperature BETWEEN 10 AND 35),
  CONSTRAINT chk_mode CHECK (mode IN ('cool', 'heat', 'dry', 'fan_only', 'auto')),
  CONSTRAINT chk_fan_speed CHECK (fan_speed IN ('auto', 'low', 'medium', 'high'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Drop old index if exists (ignore error if not present)
-- MySQL 8.4: execute via stored procedure to safely skip
SET @s = IF((SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = 'natrl' AND table_name = 'ir_codes' AND index_name = 'idx_ir_codes_lookup') > 0,
  'ALTER TABLE ir_codes DROP INDEX idx_ir_codes_lookup', 'SELECT 1');
PREPARE stmt FROM @s;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
CREATE INDEX idx_ir_codes_lookup
  ON ir_codes(brand_code, temperature, mode, fan_speed);

-- Clean old seed data (was placeholder)
DELETE FROM ir_protocols;

-- Insert real protocols (used by waveform engine for metadata)
INSERT INTO ir_protocols (brand_code, brand_name, protocol, carrier_freq, bit_length, encoding_params) VALUES
  ('gree', 'Gree', 'NEC', 38000, 64, '{"state_length": 8, "hdr_mark": 9000, "hdr_space": 4500, "bit_mark": 620, "one_space": 1600, "zero_space": 540, "gap": 19980, "temp_offset": 16}'),
  ('midea', 'Midea', 'NEC', 38000, 48, '{"state_length": 6, "hdr_mark": 4480, "hdr_space": 4480, "bit_mark": 560, "one_space": 1680, "zero_space": 560, "gap": 8100, "temp_offset": 17}'),
  ('haier', 'Haier', 'NEC', 38000, 72, '{"state_length": 9, "hdr_mark": 3000, "hdr_space": 4300, "bit_mark": 520, "one_space": 1650, "zero_space": 650, "gap": 150000, "temp_offset": 16}'),
  ('tcl', 'Tcl', 'NEC', 38000, 96, '{"state_length": 12, "hdr_mark": 1056, "hdr_space": 550, "bit_mark": 600, "one_space": 1646, "zero_space": 526, "gap": 20000, "temp_offset": 16}'),
  ('kelon', 'Kelon', 'NEC', 38000, 64, '{"state_length": 8, "hdr_mark": 9000, "hdr_space": 4600, "bit_mark": 560, "one_space": 1680, "zero_space": 600, "gap": 19950, "temp_offset": 16}'),
  ('panasonic', 'Panasonic', 'NEC', 38000, 216, '{"state_length": 27, "hdr_mark": 3456, "hdr_space": 1728, "bit_mark": 432, "one_space": 1296, "zero_space": 432, "gap": 10000, "temp_offset": 16}'),
  ('coolix', 'Coolix', 'NEC', 38000, 48, '{"state_length": 6, "hdr_mark": 4480, "hdr_space": 4480, "bit_mark": 560, "one_space": 1680, "zero_space": 560, "gap": 20000, "temp_offset": 17}'),
  ('daikin', 'Daikin', 'NEC', 38000, 280, '{"state_length": 35, "hdr_mark": 3650, "hdr_space": 1623, "bit_mark": 428, "one_space": 1280, "zero_space": 428, "gap": 29500, "temp_offset": 16}'),
  ('mitsubishi', 'Mitsubishi', 'NEC', 38000, 144, '{"state_length": 18, "hdr_mark": 3400, "hdr_space": 1750, "bit_mark": 450, "one_space": 1300, "zero_space": 420, "gap": 17500, "temp_offset": 16}'),
  ('fujitsu', 'Fujitsu', 'NEC', 38000, 128, '{"state_length": 16, "hdr_mark": 3324, "hdr_space": 1574, "bit_mark": 448, "one_space": 1188, "zero_space": 420, "gap": 10500, "temp_offset": 16}'),
  ('hitachi', 'Hitachi', 'NEC', 38000, 224, '{"state_length": 28, "hdr_mark": 3300, "hdr_space": 1700, "bit_mark": 400, "one_space": 1250, "zero_space": 500, "gap": 44500, "temp_offset": 16}'),
  ('samsung', 'Samsung', 'NEC', 38000, 112, '{"state_length": 14, "hdr_mark": 4500, "hdr_space": 4500, "bit_mark": 590, "one_space": 1690, "zero_space": 590, "gap": 45000, "temp_offset": 16}'),
  ('carrier', 'Carrier', 'NEC', 38000, 64, '{"state_length": 8, "hdr_mark": 4500, "hdr_space": 4500, "bit_mark": 570, "one_space": 1670, "zero_space": 570, "gap": 20000, "temp_offset": 16}'),
  ('lg', 'LG', 'NEC', 38000, 224, '{"state_length": 28, "hdr_mark": 8500, "hdr_space": 4250, "bit_mark": 550, "one_space": 1600, "zero_space": 550, "gap": 50000, "temp_offset": 16}'),
  ('toshiba', 'Toshiba', 'NEC', 38000, 72, '{"state_length": 9, "hdr_mark": 4400, "hdr_space": 4300, "bit_mark": 540, "one_space": 1620, "zero_space": 540, "gap": 15000, "temp_offset": 16}'),
  ('electra', 'Electra', 'NEC', 38000, 104, '{"state_length": 13, "hdr_mark": 9160, "hdr_space": 4510, "bit_mark": 646, "one_space": 1645, "zero_space": 646, "gap": 20000, "temp_offset": 16}'),
  ('whirlpool', 'Whirlpool', 'NEC', 38000, 168, '{"state_length": 21, "hdr_mark": 9060, "hdr_space": 4490, "bit_mark": 640, "one_space": 1630, "zero_space": 610, "gap": 20000, "temp_offset": 16}')
ON DUPLICATE KEY UPDATE
  brand_name = VALUES(brand_name),
  encoding_params = VALUES(encoding_params);
