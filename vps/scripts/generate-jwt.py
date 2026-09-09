#!/usr/bin/env python3
"""
Genera JWT_SECRET + tokens anon/service_role compatibles con PostgREST.

Uso:
    python3 scripts/generate-jwt.py

Solo usa la librería estándar (sin dependencias).
Guarda la salida en un lugar seguro (gestor de contraseñas).
"""
import base64
import hashlib
import hmac
import json
import secrets


def b64url(data: bytes) -> bytes:
    return base64.urlsafe_b64encode(data).rstrip(b"=")


def make_token(secret: str, role: str) -> str:
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = b64url(json.dumps({"role": role}).encode())
    sig = b64url(hmac.new(secret.encode(), header + b"." + payload, hashlib.sha256).digest())
    return (header + b"." + payload + b"." + sig).decode()


def main() -> None:
    # Secreto de 48 bytes url-safe (~64 chars). PostgREST lo usa como clave HMAC.
    jwt_secret = secrets.token_urlsafe(48)
    anon = make_token(jwt_secret, "anon")
    service = make_token(jwt_secret, "service_role")

    print("=" * 70)
    print("GUARDA ESTOS VALORES EN UN LUGAR SEGURO. No los subas a git.")
    print("=" * 70)
    print()
    print("--- Pega esto en vps/.env ---")
    print(f"JWT_SECRET={jwt_secret}")
    print(f"SERVICE_ROLE_KEY={service}")
    print()
    print("--- Token anon (normalmente no lo necesitas) ---")
    print(anon)
    print()
    print("--- Secrets para el Cloudflare Worker (paso 8 de la guía) ---")
    print("SUPA_URL=https://db.tudominio.com   (tu dominio real)")
    print(f"SUPA_SERVICE_KEY={service}")
    print()


if __name__ == "__main__":
    main()
