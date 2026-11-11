# Optional SES sender registration. The owner must still complete the verification
# email or DKIM DNS setup before SES can send from this identity.
resource "aws_sesv2_email_identity" "sender" {
  count          = var.ses_sender_email == "" ? 0 : 1
  email_identity = var.ses_sender_email
}
