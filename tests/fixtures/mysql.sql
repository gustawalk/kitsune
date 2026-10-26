-- Only for the disposable kitsune_test database on loopback fixture ports.
CREATE TABLE kitsune_fixture_identity(marker VARCHAR(100) PRIMARY KEY) ENGINE=InnoDB;
INSERT INTO kitsune_fixture_identity VALUES('kitsune-disposable-network-v1');
-- Compatible MySQL 8.4 / MariaDB 11.4 fixture; all tables use InnoDB.
CREATE TABLE customers(id BIGINT PRIMARY KEY,name VARCHAR(200) NOT NULL,email VARCHAR(200),preferred_address_id BIGINT) ENGINE=InnoDB;
CREATE TABLE addresses(id BIGINT PRIMARY KEY,customer_id BIGINT,city VARCHAR(200),street VARCHAR(200),FOREIGN KEY(customer_id) REFERENCES customers(id)) ENGINE=InnoDB;
ALTER TABLE customers ADD CONSTRAINT preferred_address_fk FOREIGN KEY(preferred_address_id) REFERENCES addresses(id);
CREATE TABLE products(id BIGINT PRIMARY KEY,name VARCHAR(200) NOT NULL,price DECIMAL(30,9),attributes JSON) ENGINE=InnoDB;
CREATE TABLE orders(id BIGINT PRIMARY KEY,customer_id BIGINT NOT NULL,status VARCHAR(50) NOT NULL DEFAULT 'pending',total DECIMAL(30,9),metadata JSON,secret_token VARCHAR(200),placed_at DATETIME(6),FOREIGN KEY(customer_id) REFERENCES customers(id)) ENGINE=InnoDB;
CREATE TABLE order_items(order_id BIGINT,line_number INTEGER,product_id BIGINT,quantity INTEGER,PRIMARY KEY(order_id,line_number),FOREIGN KEY(order_id) REFERENCES orders(id),FOREIGN KEY(product_id) REFERENCES products(id)) ENGINE=InnoDB;
CREATE TABLE payments(id BIGINT PRIMARY KEY,order_id BIGINT,status VARCHAR(50),amount DECIMAL(30,9),receipt BLOB,FOREIGN KEY(order_id) REFERENCES orders(id)) ENGINE=InnoDB;
CREATE TABLE composite_parent(tenant VARCHAR(50),code VARCHAR(50),label VARCHAR(200),PRIMARY KEY(tenant,code)) ENGINE=InnoDB;
CREATE TABLE composite_child(id BIGINT PRIMARY KEY,tenant VARCHAR(50),code VARCHAR(50),FOREIGN KEY(tenant,code) REFERENCES composite_parent(tenant,code)) ENGINE=InnoDB;
CREATE TABLE no_identity(note TEXT) ENGINE=InnoDB;
CREATE TABLE exact_values(id BIGINT UNSIGNED PRIMARY KEY,amount DECIMAL(40,20),empty_text TEXT,null_text TEXT,payload BLOB) ENGINE=InnoDB;
CREATE INDEX orders_customer_idx ON orders(customer_id);
CREATE VIEW pending_orders AS SELECT id,customer_id,status,total FROM orders WHERE status='pending';
INSERT INTO customers VALUES(1,'Avery Kim','avery@example.test',NULL),(2,'Sam Rivera',NULL,NULL);
INSERT INTO addresses VALUES(10,1,'Curitiba','Example Street');
UPDATE customers SET preferred_address_id=10 WHERE id=1;
INSERT INTO products VALUES(100,'Field notebook',19.95,'{"color":"orange"}'),(101,'Desk lamp',79,'{"wattage":12}');
INSERT INTO orders VALUES(5821,1,'pending',118.9,'{"source":"test","nullable":null}','fixture-secret-not-for-history','2026-01-01 12:00:00'),(5822,2,'completed',99999999999999999.123456789,'{}',NULL,NULL);
INSERT INTO order_items VALUES(5821,1,100,2),(5821,2,101,1);
INSERT INTO payments VALUES(700,5821,'authorized',118.9,X'00FF80');
INSERT INTO composite_parent VALUES('acme','A','Composite parent');
INSERT INTO composite_child VALUES(1,'acme','A');
INSERT INTO exact_values VALUES(18446744073709551615,12345678901234567890.12345678901234567890,'',NULL,X'00FF80');
