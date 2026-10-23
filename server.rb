require 'sinatra/base'
require 'json'
require 'securerandom'
require 'thread'
require 'aws-sdk-s3'
require 'net/http'
require 'base64'
require 'digest'

class TennisLive < Sinatra::Base
  configure do
    set :bind, '0.0.0.0'
    set :port, ENV.fetch('PORT', '10000').to_i
    set :public_folder, File.expand_path('public', __dir__)
    set :sessions, { secret: ENV.fetch('SESSION_SECRET'), httponly: true, secure: ENV.fetch('RACK_ENV', 'development') == 'production', same_site: :lax, expire_after: 86_400 }
    set :server, :puma
  end

  STATE = { events: [], next_id: 1, epoch: SecureRandom.hex(8) }
  LOCK = Mutex.new
  MAX_EVENTS = 250
  CHAT = { messages: [], next_id: 1 }
  MAX_CHAT = 300
  # Bump when the Terms/Privacy text changes so everyone re-accepts.
  LEGAL_VERSION = '2026-10-23'

  # ---- Google sign-in ----
  # Access is controlled by two comma-separated email lists set on the server.
  def self.email_list(var)
    ENV[var].to_s.split(/[\s,;]+/).map { |e| e.strip.downcase }.reject(&:empty?)
  end

  def self.google_enabled?
    !ENV['GOOGLE_CLIENT_ID'].to_s.strip.empty? && !ENV['GOOGLE_CLIENT_SECRET'].to_s.strip.empty?
  end

  def self.role_for_email(email)
    email = email.to_s.downcase
    return 'broadcaster' if email_list('BROADCASTER_EMAILS').include?(email)
    return 'viewer' if email_list('VIEWER_EMAILS').include?(email)
    nil
  end
  R2_VARS = %w[R2_BUCKET R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY].freeze
  def self.r2_missing
    R2_VARS.reject { |k| ENV[k].to_s.strip != '' }
  end
  def self.r2
    @r2 ||= Aws::S3::Client.new(
      access_key_id: ENV.fetch('R2_ACCESS_KEY_ID'),
      secret_access_key: ENV.fetch('R2_SECRET_ACCESS_KEY'),
      endpoint: ENV.fetch('R2_ENDPOINT').strip.sub(%r{^(https://[^/]+).*}, '\\1'),
      region: 'auto', force_path_style: true
    )
  end
  def self.signer
    @signer ||= Aws::S3::Presigner.new(client: r2)
  end

  before do
    cache_control :no_store
    if request.post? && request.path_info != '/login'
      origin = request.env['HTTP_ORIGIN']
      halt 403, 'Invalid origin' if origin && origin != request.base_url
    end
  end

  helpers do
    def role
      session[:role]
    end

    def display_name
      session[:name] || session[:chat_name]
    end

    def auth_fail(message)
      redirect "/?auth_error=#{Rack::Utils.escape(message)}"
    end

    def signed_in!
      halt 401, { error: 'Please log in' }.to_json unless role
    end

    # Signed in AND accepted the current Terms with an age confirmation.
    def authenticated!
      signed_in!
      halt 403, { error: 'Please accept the Terms to continue', code: 'consent_required' }.to_json unless session[:consent_version] == LEGAL_VERSION
    end

    def r2_configured!
      missing = self.class.r2_missing
      halt 503, { error: "Cloud recording not configured. Missing on server: #{missing.join(', ')}" }.to_json unless missing.empty?
    end

    def json_body
      JSON.parse(request.body.read)
    rescue JSON::ParserError
      halt 400, { error: 'Invalid JSON' }.to_json
    end
  end

  get '/' do
    send_file File.join(settings.public_folder, 'index.html')
  end

  get '/health' do
    content_type :json
    { ok: true }.to_json
  end

  get '/me' do
    content_type :json
    { role: role, name: display_name, email: session[:email], picture: session[:picture],
      google: self.class.google_enabled?, password_login: true,
      consent: session[:consent_version] == LEGAL_VERSION, age_group: session[:age_group],
      filming_ok: !!session[:filming_ok], legal_version: LEGAL_VERSION }.to_json
  end

  # Age confirmation + Terms acceptance. Under-13s are not allowed to hold an account (COPPA).
  post '/api/consent' do
    signed_in!
    content_type :json
    data = json_body
    age = data['age'].to_s
    unless %w[adult teen].include?(age)
      who = session[:email] || role
      session.clear
      warn "consent: blocked under-13 sign-in attempt (#{who}) at #{Time.now.utc.iso8601}"
      halt 403, { error: 'Courtline accounts are for people 13 and older. A parent or guardian can sign in and share the stream with you.' }.to_json
    end
    halt 400, { error: 'Please accept the Terms and Privacy Policy' }.to_json unless data['terms'] == true
    halt 400, { error: 'A parent or guardian must give permission' }.to_json if age == 'teen' && data['guardian'] != true
    halt 403, { error: 'Streaming accounts must belong to an adult (18+).' }.to_json if age == 'teen' && role == 'broadcaster'
    session[:consent_version] = LEGAL_VERSION
    session[:age_group] = age
    # No database yet: the server log is the consent record. Move this to a table when accounts land.
    warn "consent: #{session[:email] || role} age_group=#{age} guardian=#{data['guardian'] == true} terms=#{LEGAL_VERSION} at #{Time.now.utc.iso8601}"
    { ok: true }.to_json
  end

  # Streamer confirms they may film everyone on camera before going live.
  post '/api/filming-consent' do
    authenticated!
    content_type :json
    halt 403, { error: 'Only the streamer can confirm this' }.to_json unless role == 'broadcaster'
    halt 400, { error: 'Please confirm to continue' }.to_json unless json_body['confirmed'] == true
    session[:filming_ok] = true
    warn "filming-consent: #{session[:email] || role} at #{Time.now.utc.iso8601}"
    { ok: true }.to_json
  end

  get '/auth/google' do
    halt 404, 'Google sign-in is not configured' unless self.class.google_enabled?
    state = SecureRandom.urlsafe_base64(24)
    verifier = SecureRandom.urlsafe_base64(48)
    session[:oauth_state] = state
    session[:oauth_verifier] = verifier
    challenge = Base64.urlsafe_encode64(Digest::SHA256.digest(verifier), padding: false)
    query = URI.encode_www_form(
      client_id: ENV['GOOGLE_CLIENT_ID'].strip, redirect_uri: "#{request.base_url}/auth/google/callback",
      response_type: 'code', scope: 'openid email profile', state: state,
      code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account'
    )
    redirect "https://accounts.google.com/o/oauth2/v2/auth?#{query}"
  end

  get '/auth/google/callback' do
    halt 404 unless self.class.google_enabled?
    return auth_fail('Google sign-in was cancelled.') if params['error']
    expected = session.delete(:oauth_state)
    verifier = session.delete(:oauth_verifier)
    unless expected && params['state'] && Rack::Utils.secure_compare(expected, params['state'].to_s)
      return auth_fail('Sign-in expired. Please try again.')
    end

    uri = URI('https://oauth2.googleapis.com/token')
    res = Net::HTTP.post_form(uri,
      code: params['code'].to_s, client_id: ENV['GOOGLE_CLIENT_ID'].strip, client_secret: ENV['GOOGLE_CLIENT_SECRET'].strip,
      redirect_uri: "#{request.base_url}/auth/google/callback", grant_type: 'authorization_code', code_verifier: verifier.to_s)
    unless res.is_a?(Net::HTTPSuccess)
      warn "Google token exchange failed: #{res.code} #{res.body[0, 200]}"
      return auth_fail('Google sign-in failed. Please try again.')
    end

    # The ID token came straight from Google over HTTPS with our client secret,
    # so its claims can be read directly (Google's documented server-side flow).
    id_token = JSON.parse(res.body)['id_token'].to_s
    claims = JSON.parse(Base64.urlsafe_decode64(id_token.split('.')[1].to_s)) # padding is optional
    valid = claims['aud'] == ENV['GOOGLE_CLIENT_ID'].strip &&
            %w[accounts.google.com https://accounts.google.com].include?(claims['iss']) &&
            claims['exp'].to_i > Time.now.to_i && claims['email_verified']
    return auth_fail('Google sign-in could not be verified.') unless valid

    granted = self.class.role_for_email(claims['email'])
    return auth_fail("#{claims['email']} doesn't have access to this court yet. Ask the court owner to add your email.") unless granted

    session[:role] = granted
    session[:email] = claims['email'].to_s.downcase
    session[:name] = claims['name'].to_s.strip[0, 40].then { |n| n.empty? ? session[:email].split('@').first : n }
    session[:picture] = claims['picture']
    redirect '/'
  rescue StandardError => e
    warn "Google sign-in error: #{e.class}: #{e.message}"
    auth_fail('Google sign-in failed. Please try again.')
  end

  post '/login' do
    content_type :json
    data = json_body
    supplied = data['password'].to_s
    broadcast = ENV.fetch('BROADCAST_PASSWORD')
    viewer = ENV.fetch('VIEWER_PASSWORD')
    halt 400, { error: 'Missing password' }.to_json if supplied.empty?
    granted_role = if Rack::Utils.secure_compare(supplied, broadcast)
                     'broadcaster'
                   elsif Rack::Utils.secure_compare(supplied, viewer)
                     'viewer'
                   end
    halt 401, { error: 'Wrong password' }.to_json unless granted_role
    session[:role] = granted_role
    { role: granted_role }.to_json
  end

  post '/logout' do
    session.clear
    content_type :json
    { ok: true }.to_json
  end

  get '/events' do
    authenticated!
    content_type :json
    after = [[params.fetch('after', '0').to_i, 0].max, 2_000_000_000].min
    chat_after = [[params.fetch('chat_after', '0').to_i, 0].max, 2_000_000_000].min
    LOCK.synchronize do
      { epoch: STATE[:epoch], events: STATE[:events].select { |e| e[:id] > after && e[:to] == role }, last_id: STATE[:next_id] - 1,
        chat: CHAT[:messages].select { |m| m[:id] > chat_after } }.to_json
    end
  end

  # ---- Live chat ----
  post '/api/chat' do
    authenticated!
    content_type :json
    halt 413, { error: 'Message too long' }.to_json if request.content_length.to_i > 4_000
    data = json_body
    text = data['text'].to_s.gsub(/[[:cntrl:]&&[^\n]]/, '').strip[0, 500]
    halt 400, { error: 'Message is empty' }.to_json if text.empty?
    unless session[:name]
      wanted = data['name'].to_s.gsub(/[[:cntrl:]]/, '').strip[0, 30]
      session[:chat_name] = wanted unless wanted.empty?
    end
    name = display_name
    halt 400, { error: 'Choose a display name first' }.to_json if name.to_s.empty?
    now = Time.now.to_f
    halt 429, { error: 'Slow down a little' }.to_json if session[:last_chat].to_f > now - 0.7
    session[:last_chat] = now
    message = nil
    LOCK.synchronize do
      message = { id: CHAT[:next_id], name: name, role: role, text: text, at: Time.now.utc.iso8601 }
      CHAT[:next_id] += 1
      CHAT[:messages] << message
      CHAT[:messages] = CHAT[:messages].last(MAX_CHAT)
    end
    message.to_json
  end

  post '/signal' do
    authenticated!
    content_type :json
    data = json_body
    kind = data['type']
    halt 400, { error: 'Unsupported signal' }.to_json unless %w[join offer answer candidate leave].include?(kind)
    halt 403, { error: 'Confirm filming permission before going live' }.to_json if kind == 'offer' && role == 'broadcaster' && !session[:filming_ok]
    halt 400, { error: 'Signal too large' }.to_json if request.content_length.to_i > 30_000
    destination = role == 'broadcaster' ? 'viewer' : 'broadcaster'
    LOCK.synchronize do
      STATE[:events] << { id: STATE[:next_id], to: destination, from: role, type: kind, payload: data['payload'] }
      STATE[:next_id] += 1
      STATE[:events] = STATE[:events].last(MAX_EVENTS)
    end
    { ok: true }.to_json
  end

  # ICE servers for WebRTC. With Cloudflare TURN configured, phones that cannot connect
  # directly (cellular, strict Wi-Fi) relay through Cloudflare instead of dropping.
  STUN_ONLY = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }].freeze
  ICE_CACHE = { servers: nil, expires: Time.at(0) }

  def self.ice_servers
    key_id, token = ENV['CF_TURN_KEY_ID'].to_s.strip, ENV['CF_TURN_KEY_API_TOKEN'].to_s.strip
    return STUN_ONLY if key_id.empty? || token.empty?
    LOCK.synchronize { return ICE_CACHE[:servers] if ICE_CACHE[:servers] && Time.now < ICE_CACHE[:expires] }
    uri = URI("https://rtc.live.cloudflare.com/v1/turn/keys/#{key_id}/credentials/generate-ice-servers")
    res = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 5, read_timeout: 5) do |http|
      req = Net::HTTP::Post.new(uri, 'Authorization' => "Bearer #{token}", 'Content-Type' => 'application/json')
      req.body = { ttl: 86_400 }.to_json
      http.request(req)
    end
    raise "Cloudflare TURN HTTP #{res.code}" unless res.is_a?(Net::HTTPSuccess)
    servers = Array(JSON.parse(res.body)['iceServers']).map do |s|
      # Browsers block port 53, so drop those URLs.
      s.merge('urls' => Array(s['urls']).reject { |u| u =~ /:53(\?|$)/ })
    end.reject { |s| s['urls'].empty? }
    LOCK.synchronize { ICE_CACHE[:servers] = servers; ICE_CACHE[:expires] = Time.now + 12 * 3600 }
    servers
  rescue StandardError => e
    warn "TURN credentials unavailable, using STUN only: #{e.message}"
    STUN_ONLY
  end

  get '/api/ice' do
    authenticated!
    content_type :json
    { iceServers: self.class.ice_servers, relay: !ENV['CF_TURN_KEY_ID'].to_s.strip.empty? }.to_json
  end

  # R2 presigned uploads let the phone send videos directly to storage.
  post '/api/uploads' do
    authenticated!
    content_type :json
    r2_configured!
    data = json_body
    mime = data['type'].to_s.split(';').first
    ext = {'video/mp4'=>'mp4','video/webm'=>'webm','image/jpeg'=>'jpg','image/png'=>'png'}[mime]
    halt 400, {error: 'Unsupported file format'}.to_json unless ext
    size = data['size'].to_i
    halt 400, {error: 'File must be 1 byte to 150 MB'}.to_json unless size.between?(1,150*1024*1024)
    key = "recordings/#{Time.now.utc.strftime('%Y/%m/%d')}/#{SecureRandom.uuid}.#{ext}"
    url = self.class.signer.presigned_url(:put_object, bucket: ENV.fetch('R2_BUCKET').strip, key: key, content_type: mime, expires_in: 600)
    {url: url, key: key, content_type: mime}.to_json
  end

  post '/api/recordings/delete' do
    authenticated!
    content_type :json
    halt 403, { error: 'Only the streamer can delete videos' }.to_json unless role == 'broadcaster'
    r2_configured!
    key = json_body['key'].to_s
    halt 400, { error: 'Invalid file' }.to_json unless key.match?(%r{\Arecordings/\d{4}/\d{2}/\d{2}/[0-9a-f-]{36}\.(mp4|webm|jpg|png)\z})
    self.class.r2.delete_object(bucket: ENV.fetch('R2_BUCKET').strip, key: key)
    warn "delete: #{session[:email] || role} deleted #{key} at #{Time.now.utc.iso8601}"
    { ok: true }.to_json
  end

  get '/api/recordings' do
    authenticated!
    content_type :json
    r2_configured!
    result = self.class.r2.list_objects_v2(bucket: ENV.fetch('R2_BUCKET').strip, prefix: 'recordings/', max_keys: 100)
    {items: result.contents.sort_by(&:last_modified).reverse.map do |obj|
      { key: obj.key, size: obj.size, date: obj.last_modified.utc.iso8601,
        url: self.class.signer.presigned_url(:get_object, bucket: ENV.fetch('R2_BUCKET').strip, key: obj.key, expires_in: 900) }
    end}.to_json
  end

  error Aws::Errors::ServiceError do
    err = env['sinatra.error']
    content_type :json
    status 502
    { error: "Cloudflare R2 error: #{err.code || err.class.name} - #{err.message}" }.to_json
  end

  error Seahorse::Client::NetworkingError do
    content_type :json
    status 502
    { error: "Could not reach R2 endpoint (check R2_ENDPOINT): #{env['sinatra.error'].message}" }.to_json
  end

  run! if app_file == $PROGRAM_NAME
end
