require 'sinatra/base'
require 'json'
require 'securerandom'
require 'thread'

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

  run! if app_file == $PROGRAM_NAME
end
