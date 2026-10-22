require 'sinatra/base'
require 'json'
require 'securerandom'
require 'thread'
require 'aws-sdk-s3'

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

    def authenticated!
      halt 401, { error: 'Please log in' }.to_json unless role
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
    { role: role }.to_json
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
    LOCK.synchronize do
      { epoch: STATE[:epoch], events: STATE[:events].select { |e| e[:id] > after && e[:to] == role }, last_id: STATE[:next_id] - 1 }.to_json
    end
  end

  post '/signal' do
    authenticated!
    content_type :json
    data = json_body
    kind = data['type']
    halt 400, { error: 'Unsupported signal' }.to_json unless %w[join offer answer candidate leave].include?(kind)
    halt 400, { error: 'Signal too large' }.to_json if request.content_length.to_i > 30_000
    destination = role == 'broadcaster' ? 'viewer' : 'broadcaster'
    LOCK.synchronize do
      STATE[:events] << { id: STATE[:next_id], to: destination, from: role, type: kind, payload: data['payload'] }
      STATE[:next_id] += 1
      STATE[:events] = STATE[:events].last(MAX_EVENTS)
    end
    { ok: true }.to_json
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
