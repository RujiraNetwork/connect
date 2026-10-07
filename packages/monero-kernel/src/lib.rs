//! Offline cryptography only: no wallet database, daemon, RPC, or device transport.
use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT as G, scalar::Scalar as DalekScalar};
use monero_bulletproofs::Bulletproof;
use monero_clsag::{Clsag, ClsagContext, Decoys};
use monero_ed25519::{Commitment, CompressedPoint, Point, Scalar};
use monero_oxide::{
    ringct::RctPrunable,
    transaction::{Input, Transaction},
};
use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use serde::Deserialize;
use serde_json::json;
use sha3::{Digest, Keccak256};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

fn error() -> JsValue {
    JsValue::from_str("Invalid Monero cryptographic data")
}
fn key(bytes: &[u8]) -> Result<[u8; 32], JsValue> {
    bytes.try_into().map_err(|_| error())
}
fn decode(s: &str) -> Result<[u8; 32], JsValue> {
    key(&hex::decode(s).map_err(|_| error())?)
}
fn scalar(bytes: &[u8]) -> Result<DalekScalar, JsValue> {
    Option::<DalekScalar>::from(DalekScalar::from_canonical_bytes(key(bytes)?)).ok_or_else(error)
}
fn point(s: &str) -> Result<Point, JsValue> {
    let p = CompressedPoint::from(decode(s)?)
        .decompress()
        .ok_or_else(error)?;
    if !p.into().is_torsion_free() {
        return Err(error());
    }
    Ok(p)
}
fn rng(seed: &[u8]) -> Result<ChaCha20Rng, JsValue> {
    Ok(ChaCha20Rng::from_seed(key(seed)?))
}
fn varint(mut v: u64) -> Vec<u8> {
    let mut out = vec![];
    loop {
        let b = (v & 127) as u8;
        v >>= 7;
        out.push(b | if v == 0 { 0 } else { 128 });
        if v == 0 {
            break;
        }
    }
    out
}
fn digest(bytes: &[u8]) -> [u8; 32] {
    Keccak256::digest(bytes).into()
}

#[wasm_bindgen]
pub fn hash_point(public_key: &str) -> Result<String, JsValue> {
    Ok(hex::encode(
        Point::biased_hash(decode(public_key)?)
            .compress()
            .to_bytes(),
    ))
}

#[wasm_bindgen]
pub fn commitment(mask: &str, amount: &str) -> Result<String, JsValue> {
    Ok(hex::encode(
        Commitment::new(
            Scalar::from(scalar(&decode(mask)?)?),
            amount.parse().map_err(|_| error())?,
        )
        .commit()
        .compress()
        .to_bytes(),
    ))
}

#[wasm_bindgen]
pub fn prove(amounts: &str, masks: &str, seed: &[u8]) -> Result<String, JsValue> {
    let amounts: Vec<u64> = serde_json::from_str(amounts).map_err(|_| error())?;
    let masks: Vec<String> = serde_json::from_str(masks).map_err(|_| error())?;
    if amounts.len() != 2 || masks.len() != 2 {
        return Err(error());
    }
    let outputs = amounts
        .into_iter()
        .zip(masks)
        .map(|(amount, mask)| {
            Ok(Commitment::new(
                Scalar::from(scalar(&decode(&mask)?)?),
                amount,
            ))
        })
        .collect::<Result<Vec<_>, JsValue>>()?;
    let commitments = outputs
        .iter()
        .map(|c| hex::encode(c.commit().compress().to_bytes()))
        .collect::<Vec<_>>();
    let proof = Bulletproof::prove_plus(&mut rng(seed)?, outputs).map_err(|_| error())?;
    let mut signature = vec![];
    proof.signature_write(&mut signature).map_err(|_| error())?;
    Ok(json!({"proof": hex::encode(proof.serialize()), "proofHash": hex::encode(digest(&signature)), "commitments": commitments}).to_string())
}

#[derive(Deserialize)]
struct RingKey {
    dest: String,
    commitment: String,
}
#[derive(Deserialize)]
struct RingMember {
    idx: u64,
    key: RingKey,
}
#[derive(Deserialize)]
struct Source {
    outputs: Vec<RingMember>,
    real_output: usize,
    real_out_tx_key: String,
    real_out_additional_tx_keys: Vec<String>,
    real_output_in_tx_index: u64,
    amount: u64,
    mask: String,
    subaddr_minor: u32,
}
fn input_secret(spend: &[u8], view: &[u8], input: &Source) -> Result<Zeroizing<Scalar>, JsValue> {
    let spend = Zeroizing::new(scalar(spend)?);
    let view = Zeroizing::new(scalar(view)?);
    let mut candidates = vec![input.real_out_tx_key.as_str()];
    if let Some(tx_key) = input
        .real_out_additional_tx_keys
        .get(input.real_output_in_tx_index as usize)
    {
        candidates.push(tx_key.as_str());
    }
    let real = input.outputs.get(input.real_output).ok_or_else(error)?;
    let mut subaddress = Zeroizing::new(DalekScalar::ZERO);
    if input.subaddr_minor != 0 {
        let mut data = Zeroizing::new(b"SubAddr\0".to_vec());
        data.extend_from_slice(&view.to_bytes());
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(&input.subaddr_minor.to_le_bytes());
        *subaddress = Scalar::hash(&*data).into();
    }
    for tx_key in candidates {
        let derivation = (point(tx_key)?.into() * *view)
            .mul_by_cofactor()
            .compress()
            .to_bytes();
        let mut data = Zeroizing::new(derivation.to_vec());
        data.extend(varint(input.real_output_in_tx_index));
        let secret = Zeroizing::new(Scalar::from(
            Scalar::hash(&*data).into() + *spend + *subaddress,
        ));
        if hex::encode((G * (*secret).into()).compress().to_bytes()) == real.key.dest {
            return Ok(secret);
        }
    }
    Err(error())
}

#[wasm_bindgen]
pub fn software_images(spend: &[u8], view: &[u8], inputs: &str) -> Result<String, JsValue> {
    let inputs: Vec<Source> = serde_json::from_str(inputs).map_err(|_| error())?;
    let mut images = vec![];
    for input in inputs {
        let secret = input_secret(spend, view, &input)?;
        let public = input.outputs.get(input.real_output).ok_or_else(error)?;
        images.push(hex::encode(
            (Point::biased_hash(decode(&public.key.dest)?).into() * (*secret).into())
                .compress()
                .to_bytes(),
        ));
    }
    Ok(serde_json::to_string(&images).map_err(|_| error())?)
}

#[wasm_bindgen]
pub fn software_output(
    secret: &[u8],
    view: &str,
    spend: &str,
    index: u32,
    amount: &str,
) -> Result<Vec<u8>, JsValue> {
    let secret = Zeroizing::new(scalar(secret)?);
    let derivation = (point(view)?.into() * *secret)
        .mul_by_cofactor()
        .compress()
        .to_bytes();
    let mut data = Zeroizing::new(derivation.to_vec());
    data.extend(varint(u64::from(index)));
    let amount_key = Zeroizing::new(Scalar::hash(&*data).into());
    let output = (G * *amount_key + point(spend)?.into())
        .compress()
        .to_bytes();
    let mut tag_data = b"view_tag".to_vec();
    tag_data.extend(&*data);
    let tag = digest(&tag_data)[0];
    let mut mask_data = Zeroizing::new(b"commitment_mask".to_vec());
    mask_data.extend(amount_key.to_bytes());
    let mask = Zeroizing::new(Scalar::hash(&*mask_data));
    let mut amount_data = Zeroizing::new(b"amount".to_vec());
    amount_data.extend(amount_key.to_bytes());
    let cipher = digest(&amount_data);
    let amount: u64 = amount.parse().map_err(|_| error())?;
    let mut result = vec![0, 3];
    result.extend(output);
    result.push(tag);
    result.extend((*mask).into().to_bytes());
    result.extend(amount.to_le_bytes().iter().zip(cipher).map(|(a, b)| a ^ b));
    Ok(result)
}

#[wasm_bindgen]
pub fn software_sign(
    spend: &[u8],
    view: &[u8],
    inputs: &str,
    sum_outputs: &str,
    message: &str,
    seed: &[u8],
) -> Result<String, JsValue> {
    let sources: Vec<Source> = serde_json::from_str(inputs).map_err(|_| error())?;
    let mut inputs = vec![];
    for input in sources {
        if input.outputs.len() != 16 {
            return Err(error());
        }
        let secret = input_secret(spend, view, &input)?;
        let mut previous = 0;
        let mut offsets = vec![];
        let mut ring = vec![];
        for member in &input.outputs {
            offsets.push(member.idx.checked_sub(previous).ok_or_else(error)?);
            previous = member.idx;
            ring.push([point(&member.key.dest)?, point(&member.key.commitment)?]);
        }
        let decoys = Decoys::new(
            offsets,
            input.real_output.try_into().map_err(|_| error())?,
            ring,
        )
        .ok_or_else(error)?;
        let context = ClsagContext::new(
            decoys,
            Commitment::new(Scalar::from(scalar(&decode(&input.mask)?)?), input.amount),
        )
        .map_err(|_| error())?;
        inputs.push((secret, context));
    }
    let signed = Clsag::sign(
        &mut rng(seed)?,
        inputs,
        Scalar::from(scalar(&decode(sum_outputs)?)?),
        decode(message)?,
    )
    .map_err(|_| error())?;
    let mut signatures = vec![];
    let mut pseudo_outs = vec![];
    for (signature, pseudo) in signed {
        let mut bytes = vec![];
        signature.write(&mut bytes).map_err(|_| error())?;
        signatures.push(hex::encode(bytes));
        pseudo_outs.push(hex::encode(pseudo.compress().to_bytes()));
    }
    Ok(json!({"signatures": signatures, "pseudoOuts": pseudo_outs}).to_string())
}

/// Independently parse the native transaction, check proof, CLSAGs, and commitment balance.
#[wasm_bindgen]
pub fn verify_transaction(bytes: &[u8], sources: &str, seed: &[u8]) -> Result<String, JsValue> {
    let mut reader = bytes;
    let transaction = Transaction::read(&mut reader).map_err(|_| error())?;
    if !reader.is_empty() || transaction.serialize() != bytes {
        return Err(error());
    }
    let message = transaction.signature_hash().ok_or_else(error)?;
    let Transaction::V2 {
        prefix,
        proofs: Some(proofs),
    } = &transaction
    else {
        return Err(error());
    };
    let RctPrunable::Clsag {
        clsags,
        pseudo_outs,
        bulletproof,
    } = &proofs.prunable
    else {
        return Err(error());
    };
    let sources: Vec<Source> = serde_json::from_str(sources).map_err(|_| error())?;
    if clsags.len() != sources.len()
        || prefix.inputs.len() != sources.len()
        || pseudo_outs.len() != sources.len()
        || proofs.base.commitments.len() != 2
    {
        return Err(error());
    }
    if !bulletproof.verify(&mut rng(seed)?, &proofs.base.commitments) {
        return Err(error());
    }
    let mut balance = curve25519_dalek::EdwardsPoint::default();
    for ((signature, pseudo), (source, input)) in clsags
        .iter()
        .zip(pseudo_outs)
        .zip(sources.iter().zip(&prefix.inputs))
    {
        let Input::ToKey { key_image, .. } = input else {
            return Err(error());
        };
        let ring = source
            .outputs
            .iter()
            .map(|o| {
                Ok([
                    CompressedPoint::from(decode(&o.key.dest)?),
                    CompressedPoint::from(decode(&o.key.commitment)?),
                ])
            })
            .collect::<Result<Vec<_>, JsValue>>()?;
        signature
            .verify(ring, key_image, pseudo, &message)
            .map_err(|_| error())?;
        balance += pseudo.decompress().ok_or_else(error)?.into();
    }
    for output in &proofs.base.commitments {
        balance -= output.decompress().ok_or_else(error)?.into();
    }
    balance -= Commitment::new(Scalar::from(DalekScalar::ZERO), proofs.base.fee)
        .commit()
        .into();
    if balance != curve25519_dalek::EdwardsPoint::default() {
        return Err(error());
    }
    Ok(hex::encode(transaction.hash()))
}
